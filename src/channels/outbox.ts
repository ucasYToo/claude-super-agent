import { randomUUID } from "node:crypto";

import { Route, Deliver, Delivery, scopeKey } from "../agent/contracts";
import { Store } from "../storage/database";

export class Outbox {
  private active?: Promise<void>;

  constructor(
    private db: Store,
    private now: () => number,
    private send?: Deliver,
  ) {}

  add(route: Route, source: string, text: string, kind: Delivery["kind"] = "text", job?: number) {
    if (!text) {
      return;
    }
    const now = this.now();
    const target = JSON.stringify(route);
    if (kind === "card" && job) {
      const pending = this.db.one(
        `SELECT id FROM outbox
          WHERE job=? AND kind='card' AND state='pending' AND attempts=0
            AND seq > (SELECT MIN(seq) FROM outbox WHERE job=? AND kind='card')
          ORDER BY seq DESC LIMIT 1`,
        job,
        job,
      );
      if (pending) {
        this.db.run("UPDATE outbox SET text=? WHERE id=?", text, pending.id);
        return;
      }
    }
    this.db.run(
      "INSERT INTO messages(workspace,scope,route,source,direction,text,status,created) VALUES(?,?,?,?,'out',?,'ready',?)",
      route.scope.workspaceId,
      scopeKey(route.scope),
      target,
      source,
      text,
      now,
    );
    if (route.target.kind === "local") {
      return;
    }
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 3000) {
      this.db.run(
        "INSERT INTO outbox(id,seq,route,kind,text,job,next,created) VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM outbox),?,?,?,?,?,?)",
        randomUUID(),
        target,
        kind,
        chars.slice(i, i + 3000).join(""),
        job || null,
        now,
        now,
      );
    }
  }

  tick() {
    if (this.active || !this.send) {
      return;
    }
    this.active = this.flush().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async flush() {
    const due = this.db.all(
      "SELECT * FROM outbox WHERE state='pending' AND next<=? ORDER BY seq LIMIT 50",
      this.now(),
    );
    for (const item of due) {
      if (
        this.db.one(
          "SELECT id FROM outbox WHERE state='pending' AND route=? AND kind=? AND seq<? LIMIT 1",
          item.route,
          item.kind,
          item.seq,
        )
      ) {
        continue;
      }
      const now = this.now();
      if (item.first_attempt !== null && now - item.first_attempt >= 3600000) {
        this.db.run(
          "UPDATE outbox SET state='uncertain',error='请核对渠道收件记录' WHERE id=?",
          item.id,
        );
        continue;
      }
      this.db.run(
        "UPDATE outbox SET attempts=attempts+1,first_attempt=COALESCE(first_attempt,?) WHERE id=?",
        now,
        item.id,
      );
      const card =
        item.kind === "card" &&
        this.db.one("SELECT message FROM cards WHERE job=?", item.job)?.message;
      try {
        const message = await this.send!({
          id: item.id,
          route: JSON.parse(item.route),
          kind: item.kind,
          text: item.text,
          jobId: item.job,
          cardId: card || undefined,
        });
        this.db.tx(() => {
          if (item.kind === "card" && message) {
            this.db.run("INSERT OR REPLACE INTO cards VALUES(?,?)", item.job, message);
          }
          this.db.run("UPDATE outbox SET state='sent',error=NULL WHERE id=?", item.id);
        });
      } catch (e) {
        const wait = Math.max(
          Number((e as any).retryAfterMs) || 0,
          Math.min(60000, 1000 * 2 ** Math.min(6, item.attempts)),
        );
        this.db.run(
          "UPDATE outbox SET next=?,error=? WHERE id=?",
          now + wait,
          String((e as Error).message).slice(0, 300),
          item.id,
        );
      }
    }
  }

  async stop() {
    await this.active;
  }
}
