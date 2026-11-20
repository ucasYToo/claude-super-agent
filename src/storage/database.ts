import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, SQLInputValue } from "node:sqlite";

import { initialSchema } from "./schema";

export class Store {
  private db: DatabaseSync;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "agent.sqlite");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=4000;");
    const version = Number(this.one("PRAGMA user_version")?.user_version);
    if (version > 2) {
      this.close();
      throw Error("数据库来自更新的版本");
    }
    if (version === 0) {
      this.tx(() => this.db.exec(initialSchema));
    }
    if (version < 2) {
      this.tx(() =>
        this.db.exec(
          "ALTER TABLE messages ADD COLUMN turn INTEGER; CREATE INDEX messages_turn ON messages(turn); PRAGMA user_version=2;",
        ),
      );
    }
  }

  one<T = Record<string, any>>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }

  all<T = Record<string, any>>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }

  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get<T>(key: string, fallback: T): T {
    const row = this.one("SELECT value FROM settings WHERE key=?", key);
    return row ? JSON.parse(row.value) : fallback;
  }

  set(key: string, value: unknown) {
    this.run("INSERT OR REPLACE INTO settings VALUES(?,?)", key, JSON.stringify(value));
  }

  close() {
    this.db.close();
  }
}
