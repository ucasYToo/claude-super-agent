import fs from "node:fs";

import {
  Scope,
  Workspace,
  WorkerConfig,
  required,
  scopeKey,
  RunInput,
  RunResult,
} from "../agent/contracts";
import { Store } from "../storage/database";
import { atomicWrite, contained } from "../storage/files";
import { TurnRecord, JobRecord } from "../storage/records";
import { validateWorker } from "./worker-config";

const WORKER_LIMIT = 3;
const QUEUE_LIMIT = 10;
const MAX_RUNTIME_MS = 180 * 60000;

type JobSummary = Pick<
  JobRecord,
  | "id"
  | "title"
  | "state"
  | "worker"
  | "parent"
  | "continued"
  | "depth"
  | "eta"
  | "created"
  | "started"
  | "ended"
  | "result"
  | "progress"
>;

interface Bindings {
  now: () => number;
  workspace: (id: string) => Workspace;
  available: (id: string) => boolean;
  run: (input: RunInput) => Promise<RunResult>;
  report: (job: JobRecord, source: "review" | "progress") => void;
  card: (job: JobRecord, text: string) => void;
  changed: () => void;
}

export class WorkerScheduler {
  private running = new Map<number, { abort: AbortController; promise: Promise<void> }>();

  constructor(
    private db: Store,
    private runtime: Bindings,
  ) {}

  list(scope: Scope) {
    return this.db
      .all<JobSummary>(
        `SELECT id, title, state, worker, parent, continued, depth, eta, created, started, ended, result, progress
         FROM jobs WHERE scope = ? ORDER BY id DESC LIMIT 100`,
        scopeKey(scope),
      )
      .map((job) => {
        const worker: WorkerConfig = JSON.parse(job.worker);
        return { ...job, worker: worker.name, model: worker.model, cwd: worker.cwd };
      });
  }

  dispatch(turn: TurnRecord, args: Record<string, any>) {
    const operationId = turn.id + ":" + required(args.key, "操作 ID", 120);
    const old = this.db.one("SELECT id,state FROM jobs WHERE op=?", operationId);
    if (old) {
      return old;
    }
    const workspace = this.runtime.workspace(turn.workspace);
    let worker: WorkerConfig = {
      name: "default",
      purpose: "通用任务",
      model: workspace.model,
      cwd: workspace.cwd,
    };
    const parent = turn.source === "review" ? turn.job : null;
    const depth = turn.depth + 1;
    if (depth > 3) {
      throw Error("接力已达到三层");
    }
    let session: string | null = null;
    if (args.continue) {
      const previous = this.db.one<JobRecord>(
        "SELECT * FROM jobs WHERE id=? AND scope=?",
        Number(args.continue),
        turn.scope,
      );
      if (!previous?.session || ["running", "queued"].includes(previous.state)) {
        throw Error("原任务不可续跑");
      }
      worker = JSON.parse(previous.worker);
      session = previous.session;
    } else if (args.worker && args.worker !== "default") {
      const found = workspace.workers?.find((w) => w.name === args.worker);
      if (!found) {
        throw Error("Worker 不存在");
      }
      worker = { ...found };
    }
    if (worker.name !== "default") {
      validateWorker(worker, workspace);
    }
    worker.cwd = fs.realpathSync(worker.cwd || workspace.cwd);
    worker.model ||= workspace.model;
    const eta = Math.min(120, Math.max(3, Number(args.eta) || 10));
    const id = this.db.tx(() => {
      if (
        this.db.one("SELECT count(*) n FROM jobs WHERE state IN ('queued','running')")!.n >=
        WORKER_LIMIT + QUEUE_LIMIT
      ) {
        throw Error("队列已满");
      }
      const res = this.db.run(
        `INSERT INTO jobs (
           op, workspace, scope, thread, generation, route, title, prompt,
           worker, parent, continued, depth, eta, session, created
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        operationId,
        turn.workspace,
        turn.scope,
        turn.thread,
        turn.generation,
        turn.route,
        required(args.title, "标题", 200),
        required(args.prompt, "任务说明"),
        JSON.stringify(worker),
        parent,
        args.continue || null,
        depth,
        eta,
        session,
        this.runtime.now(),
      );
      const job = this.db.one<JobRecord>("SELECT * FROM jobs WHERE id=?", res.lastInsertRowid)!;
      const active = this.db.one("SELECT count(*) n FROM jobs WHERE state='running'")!.n;
      const ahead = this.db.one(
        "SELECT count(*) n FROM jobs WHERE state='queued' AND id < ?",
        job.id,
      )!.n;
      const waiting = Math.max(0, ahead - Math.max(0, WORKER_LIMIT - active));
      const description = [
        "已派发 #" + job.id + " " + job.title,
        worker.name,
        active + ahead >= WORKER_LIMIT && "排队中，前面 " + waiting + " 个任务",
        job.parent && "第 " + depth + " 层，接力 #" + job.parent,
        job.continued && "续跑 #" + job.continued,
        "预计 " + eta + " 分钟",
      ]
        .filter(Boolean)
        .join(" · ");
      this.runtime.card(job, description);
      return Number(res.lastInsertRowid);
    });
    this.runtime.changed();
    return { id, state: "queued", eta };
  }

  cancel(scope: Scope, id: number) {
    const job = this.db.one<JobRecord>(
      "SELECT * FROM jobs WHERE id=? AND scope=?",
      id,
      scopeKey(scope),
    );
    if (!job) {
      throw Error("任务不存在");
    }
    if (["queued", "running"].includes(job.state)) {
      this.db.run("UPDATE jobs SET state='cancelled',ended=? WHERE id=?", this.runtime.now(), id);
      this.running.get(id)?.abort.abort(Error("cancelled"));
      this.runtime.card(job, "已取消 #" + id + " " + job.title);
      this.runtime.changed();
    }
    return this.db.one("SELECT id,state FROM jobs WHERE id=?", id)!;
  }

  updateEta(turn: TurnRecord, eta: number) {
    if (!Number.isFinite(eta)) {
      throw Error("无效 ETA");
    }
    eta = Math.min(120, Math.max(3, eta));
    this.db.run(
      "UPDATE jobs SET eta=?,due=? WHERE id=? AND scope=? AND state='running'",
      eta,
      this.runtime.now() + eta * 60000,
      turn.job,
      turn.scope,
    );
    return { eta };
  }

  recover() {
    for (const job of this.db.all<JobRecord>("SELECT * FROM jobs WHERE state='running'")) {
      this.finish(job, "interrupted", "服务中断，可显式续跑");
    }
  }

  tick() {
    const now = this.runtime.now();
    for (const job of this.db.all<JobRecord>(
      "SELECT * FROM jobs WHERE state='running' AND due<=?",
      now,
    )) {
      this.db.tx(() => {
        this.db.run("UPDATE jobs SET due=? WHERE id=?", now + job.eta * 60000, job.id);
        this.runtime.report(job, "progress");
      });
    }
    for (const [id, execution] of this.running) {
      const job = this.db.one("SELECT started,state FROM jobs WHERE id=?", id);
      if (job?.state === "running" && now - job.started >= MAX_RUNTIME_MS) {
        execution.abort.abort(Error("timed_out"));
      }
    }
    for (const job of this.db.all<JobRecord>(
      "SELECT * FROM jobs WHERE state='queued' ORDER BY id",
    )) {
      if (this.running.size >= WORKER_LIMIT) {
        break;
      }
      if (!this.runtime.available(job.workspace)) {
        continue;
      }
      this.db.run(
        "UPDATE jobs SET state='running',started=?,due=? WHERE id=?",
        now,
        now + job.eta * 60000,
        job.id,
      );
      const abort = new AbortController();
      const promise = this.execute(job, abort).finally(() => {
        this.running.delete(job.id);
        this.runtime.changed();
      });
      this.running.set(job.id, { abort, promise });
    }
  }

  private finish(job: JobRecord, state: string, result: string) {
    this.db.tx(() => {
      if (
        !this.db.run(
          "UPDATE jobs SET state=?,ended=?,result=? WHERE id=? AND state='running'",
          state,
          this.runtime.now(),
          result,
          job.id,
        ).changes
      ) {
        return;
      }
      const latest = this.db.one<JobRecord>("SELECT * FROM jobs WHERE id=?", job.id)!;
      this.runtime.report(latest, "review");
      this.pruneHistory(job.workspace);
      this.runtime.card(latest, "#" + job.id + " " + job.title + " · " + state);
    });
  }

  private pruneHistory(workspace: string) {
    // Keep outstanding reviews and deliveries even when newer jobs fill the history.
    this.db.run(
      `DELETE FROM jobs WHERE id IN (
      SELECT id FROM jobs WHERE workspace=? AND ended IS NOT NULL
      ORDER BY ended DESC, id DESC LIMIT -1 OFFSET 50
    )
    AND NOT EXISTS (SELECT 1 FROM turns WHERE job=jobs.id AND state IN ('queued','running'))
    AND NOT EXISTS (SELECT 1 FROM outbox WHERE job=jobs.id AND state!='sent')
    AND NOT EXISTS (SELECT 1 FROM jobs AS child WHERE child.state IN ('queued','running')
      AND (child.parent=jobs.id OR child.continued=jobs.id))`,
      workspace,
    );
  }

  private async execute(job: JobRecord, abort: AbortController) {
    try {
      const workspace = this.runtime.workspace(job.workspace);
      const worker: WorkerConfig = JSON.parse(job.worker);
      if (worker.name !== "default") {
        validateWorker(worker, workspace);
      }
      if (
        ![workspace.cwd, ...(workspace.allowedCwds ?? [])].some(
          (directory) => fs.realpathSync(directory) === worker.cwd,
        )
      ) {
        throw Error("Worker 目录授权已变更");
      }
      const prefix = ".superagent/jobs/" + job.id;
      const dir = contained(workspace.cwd, prefix);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const eventFile = contained(workspace.cwd, prefix + "/events.jsonl");
      const progress = (message: string) => {
        if (abort.signal.aborted) {
          return;
        }
        fs.appendFileSync(
          eventFile,
          JSON.stringify({ time: this.runtime.now(), event: message }) + "\n",
          { mode: 0o600 },
        );
        this.db.run("UPDATE jobs SET progress=? WHERE id=?", message, job.id);
        this.runtime.card(job, "#" + job.id + " " + job.title + " · " + message);
      };
      progress("开始执行");
      const result = await this.runtime.run({
        role: "worker",
        cwd: worker.cwd!,
        claudeOptions: workspace.claudeOptions,
        excludeParentRules: workspace.excludeParentRules,
        model: worker.model,
        prompt: job.prompt,
        sessionId: job.session || undefined,
        system:
          "完成任务说明中的工作，保留证据和产物路径。只执行任务明确授权的操作。\n" +
          (worker.instructions || ""),
        tools: worker.tools || ["Read", "Grep", "Glob"],
        signal: abort.signal,
        onProgress: progress,
        onSession: (id) => this.db.run("UPDATE jobs SET session=? WHERE id=?", id, job.id),
      });
      abort.signal.throwIfAborted();
      if (result.sessionId) {
        this.db.run("UPDATE jobs SET session=? WHERE id=?", result.sessionId, job.id);
      }
      atomicWrite(contained(workspace.cwd, prefix + "/result.md"), result.text);
      this.finish(job, "succeeded", result.text);
    } catch (error) {
      const reason = abort.signal.reason?.message;
      this.finish(
        job,
        reason === "timed_out" ? "timed_out" : reason ? "interrupted" : "failed",
        String((error as Error).message || error),
      );
    }
  }

  pauseWorkspace(id: string) {
    for (const [job, execution] of this.running) {
      if (this.db.one("SELECT workspace FROM jobs WHERE id=?", job)?.workspace === id) {
        execution.abort.abort(Error("workspace switched"));
      }
    }
  }

  async stop() {
    for (const execution of this.running.values()) {
      execution.abort.abort(Error("interrupted"));
    }
    await Promise.allSettled([...this.running.values()].map((execution) => execution.promise));
  }
}
