import { Store } from "../storage/database";
import { Route, Scope, scopeKey, threadKey } from "./contracts";

export class Inbox {
  constructor(
    private db: Store,
    private now: () => number,
  ) {}

  history(
    scope: Scope,
    query = "",
    source = "",
    status = "",
    from = 0,
    to = Number.MAX_SAFE_INTEGER,
    conversation = "",
  ) {
    return this.db.all(
      `SELECT id, source, direction, text, status, created
       FROM messages
       WHERE scope = ? AND instr(text, ?) > 0
         AND (? = '' OR source = ?) AND (? = '' OR status = ?)
         AND created BETWEEN ? AND ?
         AND (? = '' OR json_extract(route, '$.conversationKey') = ?)
       ORDER BY id DESC LIMIT 200`,
      scopeKey(scope),
      query,
      source,
      source,
      status,
      status,
      from,
      to,
      conversation,
      conversation,
    );
  }

  routes(workspace: string): Route[] {
    return this.db
      .all(
        `SELECT route, MAX(id) AS latest FROM turns
         WHERE workspace = ? AND source IN ('feishu', 'web')
         GROUP BY route ORDER BY latest DESC LIMIT 100`,
        workspace,
      )
      .map((route) => JSON.parse(route.route));
  }

  enqueue(
    route: Route,
    key: string,
    source: string,
    text: string,
    generation?: number,
    job?: number,
    depth = 0,
    hasImage = false,
  ) {
    const thread = threadKey(route);
    this.db.run("INSERT OR IGNORE INTO sessions(thread) VALUES(?)", thread);
    generation ??= this.db.one(
      "SELECT generation FROM sessions WHERE thread=?",
      thread,
    )!.generation;
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO turns (
         dedup, scope, workspace, thread, generation, route, source, text, has_image, job, depth, created
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      key,
      scopeKey(route.scope),
      route.scope.workspaceId,
      thread,
      generation!,
      JSON.stringify(route),
      source,
      text,
      Number(hasImage),
      job || null,
      depth,
      this.now(),
    );
    if (!inserted.changes) {
      return this.db.one("SELECT id FROM turns WHERE dedup=?", key)!.id as number;
    }
    this.db.run(
      "INSERT INTO messages(workspace,scope,route,source,direction,text,status,created,turn) VALUES(?,?,?,?,'in',?,'accepted',?,?)",
      route.scope.workspaceId,
      scopeKey(route.scope),
      JSON.stringify(route),
      source,
      (hasImage ? "[图片] " : "") + text,
      this.now(),
      inserted.lastInsertRowid,
    );
    return Number(inserted.lastInsertRowid);
  }
}
