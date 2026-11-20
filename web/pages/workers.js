import { directoryField } from "../components/directories.js";
import {
  element,
  section,
  group,
  item,
  rows,
  form,
  field,
  button,
  panel,
  badge,
  statusName,
  modelField,
  modelChoices,
} from "../ui.js";
import { activeJob, duration } from "../components/jobs.js";
export function workers(ctx) {
  const editor = element("div");
  function edit(w = {}) {
    editor.replaceChildren(
      form(
        [
          field("名称", "name", { value: w.name, required: true }),
          field("用途", "purpose", { value: w.purpose, required: true }),
          modelField("模型", "model", w.model),
          ctx.state.settings
            ? directoryField(ctx, field("工作目录", "cwd", { value: w.cwd }))
            : field("工作目录", "cwd", { value: w.cwd }),
          field("工具（逗号分隔）", "tools", {
            value: (w.tools || ["Read", "Glob", "Grep"]).join(","),
          }),
          field("工作说明", "instructions", { value: w.instructions, long: true }),
        ],
        "保存 Worker",
        (data) =>
          ctx.action("workers/save", {
            ...data,
            tools: data.tools
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          }),
      ),
    );
    editor.querySelector('[name="name"]').readOnly = !!w.name;
  }
  edit();
  const list = rows(
    ctx.state.workspace.workers || [],
    (w) =>
      item(w.name, w.purpose, [
        button("编辑", () => edit(w)),
        button("移除", () => ctx.action("workers/remove", { name: w.name })),
      ]),
    "尚未配置专属 Worker。",
  );
  const activity = group("");
  function refresh() {
    const jobs = ctx.state.jobs;
    const names = new Set([
      "default",
      ...(ctx.state.workspace.workers || []).map((w) => w.name),
      ...jobs.filter(activeJob).map((j) => j.worker),
    ]);
    activity.replaceChildren(
      ...Array.from(names, (name) => {
        const mine = jobs.filter((j) => j.worker === name);
        const working = mine.filter((j) => j.state === "running");
        const queued = mine.filter((j) => j.state === "queued");
        const recent = mine.find((j) => !activeJob(j));
        return group(
          "item",
          group(
            "row-title",
            element("strong", "", name),
            badge(working.length ? "忙碌" : "空闲", working.length ? "blue" : "green"),
          ),
          ...working.map((j) =>
            element("p", "detail", "#" + j.id + " " + j.title + " · 已运行 " + duration(j.started)),
          ),
          ...queued.map((j) => element("p", "detail", "排队 · #" + j.id + " " + j.title)),
          element(
            "p",
            "detail",
            recent
              ? "最近 · #" + recent.id + " " + recent.title + " · " + statusName(recent.state)
              : "暂无已结束任务",
          ),
          recent?.result && element("p", "excerpt", recent.result),
        );
      }),
    );
  }
  refresh();
  ctx.onUpdate(refresh);
  return group(
    "stack",
    modelChoices(ctx.state.workspace),
    panel("工作状态", "workers", activity, button("刷新", ctx.reload)),
    group(
      "split",
      section("Worker 列表", item("default", "通用任务 · 使用主模型"), list),
      section("配置 Worker", editor),
    ),
  );
}
