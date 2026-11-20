import { badge, button, element, group, handle, rows, statusName, time } from "../ui.js";

export const activeJob = (job) => ["queued", "running"].includes(job.state);
export function duration(from, to = Date.now()) {
  if (!from) return "";
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  return seconds < 60
    ? seconds + " 秒"
    : Math.floor(seconds / 60) + " 分 " + (seconds % 60) + " 秒";
}

export function jobList(ctx, jobs = ctx.state.jobs) {
  return rows(
    jobs,
    (job) => {
      const title = element("h3", "", "#" + job.id + "  " + job.title);
      const tone = {
        running: "blue",
        queued: "amber",
        succeeded: "green",
        failed: "red",
        timed_out: "red",
      }[job.state];
      const meta = [
        job.worker,
        job.model,
        job.started && "用时 " + duration(job.started, job.ended || Date.now()),
        job.state === "running" && "预计 " + job.eta + " 分钟",
        job.parent && "接力 #" + job.parent + " · 第 " + job.depth + " 层",
        job.continued && "续 #" + job.continued,
      ].filter(Boolean);
      const details = element("details");
      const events = element("pre", "event-log");
      details.append(
        element("summary", "", "执行详情"),
        element("p", "detail", "工作目录 · " + (job.cwd || ctx.state.workspace.cwd)),
        element("p", "detail", "开始 " + time(job.started) + "　结束 " + time(job.ended)),
        events,
      );
      if (job.result) details.append(element("p", "result", job.result));
      details.addEventListener(
        "toggle",
        handle(async () => {
          if (!details.open) return;
          const log = await ctx.get("jobs/" + job.id + "/events");
          events.textContent =
            log.map((row) => time(row.time) + "  " + row.event).join("\n") || "暂无执行事件";
        }),
      );
      return group(
        "item",
        group("row-title", title, badge(statusName(job.state), tone)),
        element("p", "detail", meta.join(" · ")),
        job.progress && element("p", "detail", job.progress),
        details,
        activeJob(job) && button("取消任务", () => ctx.action("jobs/" + job.id + "/cancel")),
      );
    },
    "暂无后台任务。主会话派工后，可在这里查看进度和结果。",
  );
}
