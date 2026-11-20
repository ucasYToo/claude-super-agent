import { EventEmitter } from "node:events";
import fs from "node:fs";

import lockfile from "proper-lockfile";

import { Schedules } from "../automation/schedules";
import { Webhooks } from "../automation/webhooks";
import { imageInput } from "../channels/images";
import { Outbox } from "../channels/outbox";
import { MemoryConsolidation } from "../memory/consolidation";
import { Memory } from "../memory/files";
import { claudeRunner } from "../runtime/claude/runner";
import { ToolServer } from "../runtime/mcp/tool-server";
import { Store } from "../storage/database";
import { TurnRecord } from "../storage/records";
import { WorkerScheduler } from "../workers/scheduler";
import { WorkspaceRegistry } from "../workspaces/registry";
import { runControlCommand } from "./commands";
import {
  Inbound,
  Options,
  Route,
  Scope,
  Workspace,
  WorkerConfig,
  RunInput,
  RunResult,
  ImageInput,
  required,
  scopeKey,
  threadKey,
} from "./contracts";
import { Inbox } from "./inbox";
import { TurnExecutor } from "./turn-executor";
import { TurnTools } from "./turn-tools";

function inboundKey(route: Route, messageId: string) {
  const app =
    route.target.kind === "feishu"
      ? route.target.appId
      : scopeKey(route.scope) + ":" + route.target.clientId;
  return JSON.stringify(["user", route.target.kind, app, required(messageId, "消息 ID", 512)]);
}

export class SuperAgent {
  private store?: Store;
  private release?: () => Promise<void>;
  private timer?: NodeJS.Timeout;
  private live = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private tools = new ToolServer();
  private events = new EventEmitter();
  private images = new Map<number, ImageInput>();
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private turnCleanup = new Map<number, () => void>();
  private pulse = false;
  private out!: Outbox;
  private inbox!: Inbox;
  private registry!: WorkspaceRegistry;
  private turns!: TurnExecutor;
  private consolidation!: MemoryConsolidation;
  private jobs!: WorkerScheduler;
  readonly memory: Memory;
  schedules!: Schedules;
  webhooks!: Webhooks;
  private now: () => number;
  private run: (r: RunInput) => Promise<RunResult>;

  constructor(private options: Options) {
    this.memory = new Memory(options.dataDir, (id) => this.workspace(id).cwd);
    this.now = options.now || Date.now;
    this.run = options.runner || claudeRunner(options.claudeCommand);
  }

  private get db() {
    if (!this.store) {
      throw Error("引擎未启动");
    }
    return this.store;
  }

  start(): Promise<void> {
    if (this.stopping) {
      return this.stopping.then(() => this.start());
    }
    if (this.starting) {
      return this.starting;
    }
    if (this.live) {
      return Promise.resolve();
    }
    this.starting = this.open().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async open() {
    fs.mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
    this.release = await lockfile.lock(this.options.dataDir, {
      stale: 5000,
      update: 2000,
      retries: { retries: 6, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
    });
    try {
      this.store = new Store(this.options.dataDir);
      this.registry = new WorkspaceRegistry(this.db, this.options);
      for (const workspace of this.options.workspaces ?? []) {
        if (fs.existsSync(workspace.cwd)) {
          this.registry.get(workspace.id);
        }
      }
      this.inbox = new Inbox(this.db, this.now);
      this.out = new Outbox(this.db, this.now, this.options.deliver);
      this.jobs = new WorkerScheduler(this.db, {
        now: this.now,
        workspace: (id) => this.workspace(id),
        available: (id) => this.available(id),
        run: this.run,
        changed: () => this.changed(),
        card: (job, message) =>
          this.out.add(JSON.parse(job.route), "worker", message, "card", job.id),
        report: (job, source) =>
          this.inbox.enqueue(
            JSON.parse(job.route),
            source + ":" + job.id + ":" + (source === "progress" ? this.now() : job.state),
            source,
            JSON.stringify({
              id: job.id,
              title: job.title,
              state: job.state,
              progress: job.progress,
              result: job.result,
            }),
            job.generation,
            job.id,
            job.depth,
          ),
      });
      const enqueue = (route: Route, key: string, source: string, text: string) =>
        this.inbox.enqueue(route, key, source, text);
      this.schedules = new Schedules(this.db, this.now, enqueue);
      this.webhooks = new Webhooks(this.db, this.now, enqueue);
      this.turns = new TurnExecutor(this.db, {
        dataDir: this.options.dataDir,
        workspaces: this.registry,
        tools: new TurnTools({
          server: this.tools,
          jobs: this.jobs,
          workspaces: this.registry,
          schedules: this.schedules,
          memory: this.memory,
        }),
        memory: this.memory,
        outbox: this.out,
        changed: () => this.changed(),
        run: this.run,
        now: this.now,
      });
      this.consolidation = new MemoryConsolidation(
        this.db,
        this.memory,
        this.registry,
        this.active,
        this.run,
        this.now,
        () => this.changed(),
        (id) => this.available(id),
        (message) => this.events.emit("change", { kind: "memory-error", message }),
      );
      await this.tools.start();
      this.db.tx(() => {
        for (const row of this.db.all(
          "SELECT * FROM turns WHERE state='running' OR (state='queued' AND has_image=1)",
        )) {
          this.db.run("UPDATE turns SET state='interrupted' WHERE id=?", row.id);
          this.out.add(
            JSON.parse(row.route),
            row.source,
            "会话因服务中断，请重新发送" + (row.has_image ? "图片" : "消息"),
          );
        }
      });
      this.jobs.recover();
      this.schedules.tick(true, (id) => this.available(id));
      this.live = true;
      this.timer = setInterval(() => this.tick(), this.options.tickMs || 500);
      this.tick();
    } catch (e) {
      await this.tools.stop();
      this.store?.close();
      this.store = undefined;
      await this.release();
      this.release = undefined;
      throw e;
    }
  }

  stop(): Promise<void> {
    if (this.starting) {
      return this.starting.then(() => this.stop());
    }
    if (this.stopping) {
      return this.stopping;
    }
    if (!this.live) {
      return Promise.resolve();
    }
    this.stopping = this.close().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async close() {
    this.live = false;
    clearInterval(this.timer);
    for (const r of [...this.active.values(), ...this.consolidation.cleaning.values()]) {
      r.abort.abort(Error("服务已停止"));
    }
    await Promise.allSettled([
      this.jobs.stop(),
      ...Array.from(this.active.values(), (r) => r.done),
      ...Array.from(this.consolidation.cleaning.values(), (r) => r.done),
    ]);
    for (const cleanup of this.turnCleanup.values()) cleanup();
    this.turnCleanup.clear();
    await this.out.stop();
    await this.tools.stop();
    this.store?.close();
    this.store = undefined;
    this.images.clear();
    await this.release?.();
    this.release = undefined;
  }

  onEvent(fn: (e: { kind: string }) => void) {
    this.events.on("change", fn);
    return () => {
      this.events.off("change", fn);
    };
  }

  private changed() {
    if (!this.live || this.pulse) {
      return;
    }
    this.pulse = true;
    setImmediate(() => {
      this.pulse = false;
      if (this.live) {
        this.events.emit("change", { kind: "change" });
        this.tick();
      }
    });
  }

  workspace(id: string) {
    return this.registry.get(id);
  }

  updateWorkspace(id: string, patch: Partial<Workspace>) {
    return this.registry.updateWorkspace(id, patch);
  }

  setWorker(id: string, worker: WorkerConfig, remove = false) {
    return this.registry.setWorker(id, worker, remove);
  }

  history(...query: Parameters<Inbox["history"]>) {
    return this.inbox.history(...query);
  }

  routes(workspace: string) {
    this.workspace(workspace);
    return this.inbox.routes(workspace);
  }

  selectWorkspace(id: string | null) {
    if (id === null) {
      this.db.set("selected", null);
      this.changed();
      return;
    }
    this.workspace(id);
    for (const r of this.db.all("SELECT DISTINCT workspace FROM jobs WHERE state='running'")) {
      if (r.workspace !== id) {
        this.jobs.pauseWorkspace(r.workspace);
      }
    }
    this.db.set("selected", id);
    this.changed();
  }

  private available(id: string) {
    try {
      this.workspace(id);
    } catch {
      return false;
    }
    const selected = this.db.get<string | null>("selected", null);
    return !selected || selected === id;
  }

  status() {
    return {
      running: this.live,
      activeTurns: this.active.size,
      selected: this.db.get("selected", null),
      jobs: this.db.all("SELECT state,count(*) AS count FROM jobs GROUP BY state"),
      deliveries: this.db.all("SELECT state,count(*) AS count FROM outbox GROUP BY state"),
    };
  }

  sessionDetails(route: Route) {
    const thread = threadKey(route);
    const row = this.db.one(
      "SELECT generation, session FROM sessions LEFT JOIN resumes USING(thread,generation) WHERE thread=?",
      thread,
    );
    const queued = this.db.one(
      "SELECT count(*) AS count FROM turns WHERE thread=? AND state='queued'",
      thread,
    );
    return {
      pid: this.turns.processes.get(thread) ?? null,
      generation: row?.generation ?? 0,
      sessionId: row?.session ?? null,
      queued: queued?.count ?? 0,
    };
  }

  memoryStatus(scope: Scope) {
    return this.consolidation.status(scope);
  }

  sessionStatus(route: Route) {
    const thread = threadKey(route);
    if (this.db.get<number[]>("failures:" + thread, []).length >= 3) {
      return "paused";
    }
    if (this.consolidation.cleaning.has(scopeKey(route.scope))) {
      return "consolidating";
    }
    return this.active.has(thread) ? "running" : "idle";
  }

  listJobs(scope: Scope) {
    return this.jobs.list(scope);
  }

  cancelJob(scope: Scope, id: number) {
    return this.jobs.cancel(scope, id);
  }

  receivedTurnId(route: Route, messageId: string): number | undefined {
    return this.db.one<{ id: number }>(
      "SELECT id FROM turns WHERE dedup=?",
      inboundKey(route, messageId),
    )?.id;
  }

  async handleMessage(input: Inbound, onTurnEnd?: () => void) {
    if (!this.live || !this.available(input.scope.workspaceId)) {
      throw Error("工作区未启用");
    }
    const route: Route = {
      scope: input.scope,
      target: input.target,
      conversationKey: required(input.conversationKey, "会话标识", 1024),
    };
    required(route.scope.ownerId, "用户", 512);
    const text = input.image
      ? String(input.text || "").slice(0, 32000)
      : required(input.text, "消息", 32000);
    const image = input.image ? imageInput(input.image.data) : undefined;
    const key = inboundKey(route, input.messageId);
    const result = this.db.tx(() => {
      const previous = this.db.one("SELECT id FROM turns WHERE dedup=?", key);
      if (previous) {
        return { turnId: Number(previous.id), duplicate: true };
      }
      const source = input.target.kind === "feishu" ? "feishu" : "web";
      const id = this.inbox.enqueue(
        route,
        key,
        source,
        text,
        undefined,
        undefined,
        0,
        !!input.image,
      );
      if (!input.image && this.control(route, id, text)) {
        return { turnId: id, duplicate: false };
      }
      if (image) {
        this.images.set(id, image);
      }
      return { turnId: id, duplicate: false };
    });
    if (onTurnEnd) {
      if (
        !result.duplicate &&
        this.db.one("SELECT state FROM turns WHERE id=?", result.turnId)?.state === "queued"
      ) {
        this.turnCleanup.set(result.turnId, onTurnEnd);
      } else {
        onTurnEnd();
      }
    }
    this.changed();
    return result;
  }

  private control(route: Route, turnId: number, text: string) {
    if (!text.startsWith("/")) {
      return false;
    }

    let reply: string | undefined;
    try {
      reply = runControlCommand(this, route.scope, text, (command) => {
        const thread = threadKey(route);
        this.active.get(thread)?.abort.abort(Error("本轮已中断"));
        if (command === "/stop") {
          return "已中断当前轮次";
        }
        this.db.set("failures:" + thread, []);
        if (command === "/restart") {
          return "已重启主会话，保留上下文";
        }
        this.db.run("UPDATE sessions SET generation=generation+1 WHERE thread=?", thread);
        return "已开始新会话";
      });
    } catch (error) {
      reply = (error as Error).message;
    }

    if (reply === undefined) {
      return false;
    }
    this.db.run("UPDATE turns SET state='done',answer=? WHERE id=?", reply, turnId);
    this.out.add(route, "control", reply);
    return true;
  }

  private tick() {
    if (!this.live) {
      return;
    }
    try {
      this.schedules.tick(false, (id) => this.available(id));
      this.jobs.tick();
      void this.out.tick()?.catch((error: Error) => {
        this.events.emit("change", { kind: "delivery-error", message: error.message });
      });
      this.consolidation.nightly();
      for (const turn of this.db.all<TurnRecord>(
        "SELECT * FROM turns WHERE state='queued' ORDER BY id",
      )) {
        if (
          this.active.has(turn.thread) ||
          this.consolidation.cleaning.has(turn.scope) ||
          !this.available(turn.workspace)
        ) {
          continue;
        }
        if (this.db.get<number[]>("failures:" + turn.thread, []).length >= 3) {
          continue;
        }
        this.db.run("UPDATE turns SET state='running' WHERE id=?", turn.id);
        const abort = new AbortController();
        const done = this.turns.execute(turn, abort, this.images.get(turn.id)).finally(() => {
          this.images.delete(turn.id);
          this.active.delete(turn.thread);
          this.turnCleanup.get(turn.id)?.();
          this.turnCleanup.delete(turn.id);
          this.changed();
        });
        this.active.set(turn.thread, { abort, done });
      }
    } catch (e) {
      this.events.emit("change", { kind: "error", message: (e as Error).message });
    }
  }

  writeMemory(scope: Scope, name: string, text: string) {
    this.consolidation.writeMemory(scope, name, text);
  }

  consolidate(scope: Scope) {
    return this.consolidation.consolidate(scope);
  }
}

export const createSuperAgent = (options: Options) => new SuperAgent(options);
