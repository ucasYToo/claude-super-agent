import { directoryField } from "../components/directories.js";
import {
  element,
  section,
  group,
  rows,
  item,
  form,
  field,
  button,
  modelChoices,
  modelField,
} from "../ui.js";

export function settings(ctx) {
  const workspace = ctx.state.workspace;
  const runtime = form(
    [
      modelField("主模型", "model", workspace.model),
      modelField("图片模型", "visionModel", workspace.visionModel),
      modelField("辅助模型", "auxiliaryModel", workspace.auxiliaryModel),
      field("Claude 额外选项（每行一项）", "claudeOptions", {
        long: true,
        value: workspace.claudeOptions?.join("\n"),
        placeholder: "--effort high\n--fallback-model sonnet\n--max-budget-usd 2",
      }),
      field("时区", "timezone", {
        value: workspace.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
      field("夜间整理时间（清空可关闭）", "consolidateAt", {
        type: "time",
        value: workspace.consolidateAt ?? "03:00",
      }),
      field("单轮时限（分钟）", "turnTimeoutMinutes", {
        type: "number",
        value: workspace.turnTimeoutMinutes || 30,
      }),
    ],
    "保存运行设置",
    (data) =>
      ctx.action("workspace/save", {
        ...data,
        claudeOptions: data.claudeOptions
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        turnTimeoutMinutes: Number(data.turnTimeoutMinutes),
      }),
  );
  const reset = button("恢复默认模型", () => {
    for (const key of ["model", "visionModel", "auxiliaryModel"]) runtime.elements[key].value = "";
    runtime.elements.model.focus();
  });
  const panels = [
    section("模型与运行参数", element("p", "pathline", workspace.cwd), runtime, reset),
  ];
  const config = ctx.state.settings;
  if (!config) {
    return group("stack", modelChoices(workspace), ...panels);
  }
  panels.push(
    section(
      "Claude CLI",
      form(
        [
          field("可执行命令或绝对路径", "claudeCommand", {
            required: true,
            value: config.claudeCommand,
          }),
        ],
        "保存启动命令",
        (data) => ctx.action("settings/save", data),
      ),
    ),
  );
  const activeWorkspace = ctx.state.status.selected;
  if (activeWorkspace !== workspace.id) {
    panels.push(
      section(
        "工作区调度",
        element(
          "p",
          "detail",
          activeWorkspace ? "当前启用 " + activeWorkspace : "当前所有工作区均可运行任务。",
        ),
        button("只启用此工作区", () => ctx.action("workspace/select", {})),
      ),
    );
  }
  panels.push(
    section(
      "添加工作区",
      form(
        [
          field("标识", "id", { required: true }),
          directoryField(ctx, field("本机绝对路径", "cwd", { required: true })),
        ],
        "添加工作区",
        (data) => ctx.action("settings/save", { workspaces: [...config.workspaces, data] }),
      ),
    ),
  );
  if (activeWorkspace) {
    panels.push(button("恢复所有工作区调度", () => ctx.action("workspace/select", { all: true })));
  }
  return group(
    "settings-grid",
    modelChoices(workspace),
    panels[0],
    group("stack", ...panels.slice(1)),
  );
}
