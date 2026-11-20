import { createHash, randomBytes } from "node:crypto";

import { Route, Scope, scopeKey, required } from "../agent/contracts";
import { Store } from "../storage/database";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export class Webhooks {
  constructor(
    private db: Store,
    private now: () => number,
    private enqueue: (route: Route, key: string, source: string, text: string) => number,
  ) {}

  hooks(scope: Scope) {
    return this.db.all(
      "SELECT id,title,prompt,enabled,last FROM hooks WHERE scope=? ORDER BY id DESC",
      scopeKey(scope),
    );
  }

  addHook(route: Route, args: Record<string, any>) {
    if (
      this.db.one("SELECT count(*) n FROM hooks WHERE workspace=?", route.scope.workspaceId)!.n >=
      20
    ) {
      throw Error("工作区最多 20 个 Webhook");
    }
    const secret = randomBytes(32).toString("hex");
    const id = this.db.run(
      "INSERT INTO hooks(workspace,scope,route,title,prompt,secret) VALUES(?,?,?,?,?,?)",
      route.scope.workspaceId,
      scopeKey(route.scope),
      JSON.stringify(route),
      required(args.title, "标题", 160),
      required(args.prompt, "指令"),
      hash(secret),
    ).lastInsertRowid;
    return { id: Number(id), secret };
  }

  hookAction(scope: Scope, id: number, action: string, args: Record<string, any> = {}) {
    if (!this.db.one("SELECT id FROM hooks WHERE scope=? AND id=?", scopeKey(scope), id)) {
      throw Error("Webhook 不存在");
    }
    if (action === "rotate") {
      const secret = randomBytes(32).toString("hex");
      this.db.run("UPDATE hooks SET secret=? WHERE id=?", hash(secret), id);
      return { secret };
    }
    if (action === "remove") {
      this.db.run("DELETE FROM hooks WHERE id=?", id);
    } else if (action === "enable" || action === "disable") {
      this.db.run("UPDATE hooks SET enabled=? WHERE id=?", Number(action === "enable"), id);
    } else if (action === "edit") {
      this.db.run(
        "UPDATE hooks SET title=?,prompt=? WHERE id=?",
        required(args.title, "标题", 160),
        required(args.prompt, "指令"),
        id,
      );
    } else {
      throw Error("未知操作");
    }
  }

  trigger(
    secret: string,
    msg: unknown,
    eventId: string | undefined,
    active: (wid: string) => boolean,
  ) {
    if (msg !== undefined && typeof msg !== "string") {
      throw Error("msg 需要是文本");
    }
    return this.db.tx(() => {
      const row = this.db.one("SELECT * FROM hooks WHERE enabled=1 AND secret=?", hash(secret));
      if (!row || !active(row.workspace)) {
        throw Object.assign(Error("Webhook 不存在"), { status: 404 });
      }
      const now = this.now();
      const key = eventId ? required(eventId, "事件编号", 256) : String(now);
      const old = this.db.one("SELECT turn FROM hook_events WHERE hook=? AND event=?", row.id, key);
      if (eventId && old) {
        return { turnId: old.turn, duplicate: true };
      }
      if (row.last !== null && now - row.last < 60000) {
        throw Object.assign(Error("每分钟最多触发一次"), { status: 429 });
      }
      const text =
        msg === undefined
          ? row.prompt
          : JSON.stringify({ instruction: row.prompt, external: msg.slice(0, 4000) });
      const turnId = this.enqueue(
        JSON.parse(row.route),
        "hook:" + row.id + ":" + key,
        msg === undefined ? "hook" : "external",
        text,
      );
      this.db.run("UPDATE hooks SET last=? WHERE id=?", now, row.id);
      this.db.run("INSERT INTO hook_events VALUES(?,?,?)", row.id, key, turnId);
      return { turnId, duplicate: false };
    });
  }
}
