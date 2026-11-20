import { RunInput, RunResult, Scope, scopeKey } from "../agent/contracts";
import { Store } from "../storage/database";
import { WorkspaceRegistry } from "../workspaces/registry";
import { Memory } from "./files";

type ActiveTurn = { abort: AbortController; done: Promise<void> };

export class MemoryConsolidation {
  readonly cleaning = new Map<string, ActiveTurn>();

  constructor(
    private db: Store,
    private memory: Memory,
    private workspaces: WorkspaceRegistry,
    private active: ReadonlyMap<string, ActiveTurn>,
    private run: (input: RunInput) => Promise<RunResult>,
    private now: () => number,
    private changed: () => void,
    private available: (id: string) => boolean,
    private reportError: (message: string) => void,
  ) {}

  writeMemory(scope: Scope, name: string, text: string) {
    if (this.cleaning.has(scopeKey(scope))) {
      throw Error("正在整理记忆");
    }
    this.memory.write(scope, name, text);
  }

  status(scope: Scope) {
    const key = scopeKey(scope);
    return {
      running: this.cleaning.has(key),
      last: this.db.get("memory-last:" + key, null),
    };
  }

  consolidate(scope: Scope, source: "manual" | "scheduled" = "manual") {
    const key = scopeKey(scope);
    const old = this.cleaning.get(key);
    if (old) {
      return old.done;
    }
    const abort = new AbortController();
    const ws = this.workspaces.get(scope.workspaceId);
    const started = this.now();
    let records = 0;
    const record = (outcome: string) =>
      this.db.set("memory-last:" + key, {
        source,
        started,
        finished: this.now(),
        records,
        outcome,
      });
    const done = (async () => {
      const running = [...this.active].filter(([t]) => {
        const [w, u] = JSON.parse(t);
        return w === scope.workspaceId && u === scope.ownerId;
      });
      await Promise.allSettled(running.map(([, v]) => v.done));
      abort.signal.throwIfAborted();
      const since = this.db.get("memory-cursor:" + key, 0);
      const rows = this.db.all(
        "SELECT id,text,direction FROM messages WHERE scope=? AND id>? ORDER BY id",
        key,
        since,
      );
      records = rows.length;
      if (!rows.length) {
        record("empty");
        return;
      }
      await this.memory.consolidate(
        scope,
        JSON.stringify(rows),
        new Date(this.now()).toISOString().slice(0, 7),
        this.run,
        abort.signal,
        ws.auxiliaryModel || ws.model,
      );
      this.db.tx(() => {
        record("success");
        this.db.set("memory-cursor:" + key, rows.at(-1)!.id);
        for (const row of this.db.all("SELECT DISTINCT thread FROM turns WHERE scope=?", key)) {
          this.db.run("UPDATE sessions SET generation=generation+1 WHERE thread=?", row.thread);
          this.db.run(
            "UPDATE turns SET generation=(SELECT generation FROM sessions WHERE thread=?) WHERE thread=? AND state='queued' AND job IS NULL",
            row.thread,
            row.thread,
          );
        }
      });
    })()
      .catch((error) => {
        record("failed");
        throw error;
      })
      .finally(() => {
        this.cleaning.delete(key);
        this.changed();
      });
    this.cleaning.set(key, { abort, done });
    this.changed();
    return done;
  }
  private lastNightMinute = -1;

  nightly() {
    const minute = Math.floor(this.now() / 60000);
    if (minute === this.lastNightMinute) {
      return;
    }
    this.lastNightMinute = minute;
    for (const { scope, workspace } of this.db.all("SELECT DISTINCT scope,workspace FROM turns")) {
      if (!this.available(workspace)) {
        continue;
      }
      const ws = this.workspaces.get(workspace);
      const clock = new Intl.DateTimeFormat("sv-SE", {
        timeZone: ws.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(this.now()));
      if (
        clock.slice(-5) !== (ws.consolidateAt ?? "03:00") ||
        this.db.get("night:" + scope, "") === clock.slice(0, 10)
      ) {
        continue;
      }
      const [workspaceId, ownerId] = JSON.parse(scope);
      this.db.set("night:" + scope, clock.slice(0, 10));
      void this.consolidate({ workspaceId, ownerId }, "scheduled").catch((e) =>
        this.reportError(e.message),
      );
    }
  }
}
