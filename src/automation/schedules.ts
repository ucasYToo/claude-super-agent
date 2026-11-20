import { CronExpressionParser } from "cron-parser";

import { Route, Scope, scopeKey, required } from "../agent/contracts";
import { Store } from "../storage/database";

export function nextCron(cron: string, tz: string, date: number) {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw Error("请输入五段 cron");
  }
  const expression = CronExpressionParser.parse(cron, { tz, currentDate: new Date(date) });
  return expression.next().getTime();
}

export class Schedules {
  constructor(
    private db: Store,
    private now: () => number,
    private enqueue: (route: Route, key: string, source: string, text: string) => number,
  ) {}

  schedules(scope: Scope) {
    return this.db.all("SELECT * FROM schedules WHERE scope=? ORDER BY id DESC", scopeKey(scope));
  }

  addSchedule(route: Route, args: Record<string, any>, pending = false) {
    if (
      this.db.one("SELECT count(*) n FROM schedules WHERE workspace=?", route.scope.workspaceId)!
        .n >= 50
    ) {
      throw Error("工作区最多 50 个定时任务");
    }
    const { tz, at, next } = this.timing(args);
    const result = this.db.run(
      "INSERT INTO schedules(workspace,scope,route,title,prompt,cron,at,tz,next,state) VALUES(?,?,?,?,?,?,?,?,?,?)",
      route.scope.workspaceId,
      scopeKey(route.scope),
      JSON.stringify(route),
      required(args.title, "标题", 160),
      required(args.prompt, "指令"),
      args.cron || null,
      at,
      tz,
      next,
      pending ? "pending" : "active",
    );
    return Number(result.lastInsertRowid);
  }

  private timing(args: Record<string, any>) {
    const tz = args.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    new Intl.DateTimeFormat("en", { timeZone: tz });
    if (!!args.cron === !!args.at) {
      throw Error("请选择 cron 或单次执行时间");
    }
    const now = this.now();
    const at = args.at ? new Date(args.at).getTime() : null;
    const next = args.cron ? nextCron(args.cron, tz, now) : at;
    if (!next || !Number.isFinite(next) || next <= now) {
      throw Error("请输入未来的执行时间");
    }
    if (args.cron && nextCron(args.cron, tz, next) - next < 600000) {
      throw Error("执行间隔至少十分钟");
    }
    return { tz, at, next };
  }

  edit(scope: Scope, id: number, args: Record<string, any>) {
    const row = this.db.one(
      "SELECT state FROM schedules WHERE id=? AND scope=?",
      id,
      scopeKey(scope),
    );
    if (!row) throw Error("定时任务不存在");
    const { tz, at, next } = this.timing(args);
    this.db.run(
      "UPDATE schedules SET title=?,prompt=?,cron=?,at=?,tz=?,next=?,state=? WHERE id=? AND scope=?",
      required(args.title, "标题", 160),
      required(args.prompt, "指令"),
      args.cron || null,
      at,
      tz,
      next,
      row.state === "done" ? "active" : row.state,
      id,
      scopeKey(scope),
    );
  }

  scheduleAction(scope: Scope, id: number, action: string) {
    const row = this.db.one("SELECT * FROM schedules WHERE id=? AND scope=?", id, scopeKey(scope));
    if (!row) {
      throw Error("定时任务不存在");
    }
    if (action === "remove" || action === "reject") {
      this.db.run("DELETE FROM schedules WHERE id=?", id);
      return;
    }
    if (action === "run") {
      if (row.state === "pending") {
        throw Error("任务尚待批准");
      }
      this.fire(row, this.now());
      return;
    }
    if (
      (action === "approve" && row.state !== "pending") ||
      (action === "resume" && row.state !== "paused")
    ) {
      throw Error("状态不匹配");
    }
    if (
      !["approve", "resume", "pause"].includes(action) ||
      (action === "pause" && row.state === "pending")
    ) {
      throw Error("无效的操作");
    }
    this.db.run(
      "UPDATE schedules SET state=?,next=? WHERE id=?",
      action === "pause" ? "paused" : "active",
      row.cron ? nextCron(row.cron, row.tz, this.now()) : row.at,
      id,
    );
  }

  private fire(row: Record<string, any>, due: number) {
    const last =
      row.last_turn && this.db.one("SELECT state,created FROM turns WHERE id=?", row.last_turn);
    if (
      last &&
      (["queued", "running"].includes(last.state) ||
        (row.cron && this.now() - last.created < 600000))
    ) {
      return;
    }
    const turn = this.enqueue(
      JSON.parse(row.route),
      "schedule:" + row.id + ":" + due,
      "schedule",
      "定时任务 #" + row.id + " " + row.title + "\n" + row.prompt,
    );
    this.db.run("UPDATE schedules SET last_turn=? WHERE id=?", turn, row.id);
  }

  tick(startup = false, active: (workspace: string) => boolean = () => true) {
    const now = this.now();
    for (const row of this.db.all(
      "SELECT * FROM schedules WHERE state='active' AND next<=?",
      now,
    )) {
      if (!active(row.workspace)) {
        continue;
      }
      this.db.tx(() => {
        if (!(row.cron && startup)) {
          this.fire(row, row.next);
        }
        this.db.run(
          "UPDATE schedules SET state=?,next=? WHERE id=?",
          row.cron ? "active" : "done",
          row.cron ? nextCron(row.cron, row.tz, now) : null,
          row.id,
        );
      });
    }
  }
}
