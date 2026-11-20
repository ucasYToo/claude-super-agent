import { jobList } from "../components/jobs.js";
import {
  element,
  section,
  group,
  item,
  rows,
  form,
  field,
  button,
  time,
  statusName,
  notify,
  panel,
} from "../ui.js";

export function schedules(ctx) {
  const scheduleType = field("重复方式", "mode", {
    choices: [
      ["once", "一次性"],
      ["daily", "每天"],
      ["weekday", "工作日"],
      ["weekly", "每周"],
      ["cron", "自定义 cron"],
    ],
  });
  const once = field("执行时间", "at", { type: "datetime-local" });
  const hour = field("本地时间", "clock", { type: "time", value: "09:00" });
  const day = field("星期", "day", {
    choices: ["日", "一", "二", "三", "四", "五", "六"].map((d, i) => [i, "星期" + d]),
  });
  const cron = field("Cron（五段）", "cron", { placeholder: "0 17 * * 5" });
  function toggle() {
    const mode = scheduleType.lastChild.value;
    once.hidden = mode !== "once";
    cron.hidden = mode !== "cron";
    day.hidden = mode !== "weekly";
    hour.hidden = ["once", "cron"].includes(mode);
  }
  scheduleType.addEventListener("change", toggle);
  toggle();
  let editing;
  const create = form(
    [
      field("标题", "title", { required: true }),
      field("任务说明", "prompt", { long: true, required: true }),
      scheduleType,
      once,
      hour,
      day,
      cron,
      field("时区", "tz", {
        value: ctx.state.workspace.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    ],
    "添加定时任务",
    async (data) => {
      const [h, m] = data.clock.split(":").map(Number);
      const pattern =
        data.mode === "cron"
          ? data.cron
          : [
              m,
              h,
              "*",
              "*",
              data.mode === "weekly" ? data.day : data.mode === "weekday" ? "1-5" : "*",
            ].join(" ");
      await ctx.action(editing ? "tasks/edit" : "tasks/add", {
        id: editing,
        title: data.title,
        prompt: data.prompt,
        tz: data.tz,
        ...(data.mode === "once" ? { at: new Date(data.at).toISOString() } : { cron: pattern }),
      });
    },
  );
  function editTask(task) {
    editing = task.id;
    const fields = create.elements;
    fields.title.value = task.title;
    fields.prompt.value = task.prompt;
    fields.tz.value = task.tz;
    fields.mode.value = task.cron ? "cron" : "once";
    fields.cron.value = task.cron || "";
    if (task.at) {
      const date = new Date(task.at);
      fields.at.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    }
    toggle();
    create.querySelector("button[type=submit]").textContent = "保存任务";
    fields.title.focus();
  }
  const renderTask = (task) => {
    const act = (title, op) => button(title, () => ctx.action("tasks/" + op, { id: task.id }));
    const buttons =
      task.state === "pending"
        ? [act("批准", "approve"), act("拒绝", "reject")]
        : [
            act("运行一次", "run"),
            ...(task.state === "active"
              ? [act("暂停", "pause")]
              : task.state === "paused"
                ? [act("恢复", "resume")]
                : []),
          ];
    buttons.push(
      button("编辑", () => editTask(task)),
      act("删除", "remove"),
    );
    const row = item(
      task.title,
      statusName(task.state) + " · " + (task.cron || "单次") + " · 下次 " + time(task.next),
      buttons,
    );
    row.append(element("p", "excerpt", task.prompt));
    return row;
  };
  const pending = ctx.state.tasks.filter((task) => task.state === "pending");
  const jobs = group("", jobList(ctx));
  ctx.onUpdate(() => jobs.replaceChildren(jobList(ctx)));
  return group(
    "stack",
    pending.length && panel("待批准 · " + pending.length, "clock", rows(pending, renderTask, "")),
    group(
      "split",
      panel(
        "任务计划",
        "clock",
        rows(
          ctx.state.tasks.filter((task) => task.state !== "pending"),
          renderTask,
          "暂无定时任务。",
        ),
        button("刷新", ctx.reload),
      ),
      section(
        "任务编辑器",
        create,
        button("新建任务", () => {
          editing = undefined;
          create.reset();
          toggle();
          create.querySelector("button[type=submit]").textContent = "添加定时任务";
        }),
      ),
    ),
    panel("临时任务", "workers", jobs),
  );
}

export function webhooks(ctx) {
  const editor = element("div");
  async function showSecret(result) {
    const url = new URL("./api/webhook/" + result.secret, document.baseURI).href;
    await ctx.reload();
    const address = field("调用地址", "url", { value: url });
    address.lastChild.readOnly = true;
    const copy = button("复制地址", async () => {
      address.lastChild.select();
      if (navigator.clipboard) await navigator.clipboard.writeText(url);
      else if (!document.execCommand("copy")) throw Error("请选择并复制地址");
      copy.textContent = "已复制";
    });
    document.querySelector("#content").prepend(section("新调用地址", address, copy));
    notify("请保存本次生成的地址。");
  }
  function edit(hook) {
    editor.replaceChildren(
      form(
        [
          field("名称", "title", { value: hook?.title, required: true }),
          field("处理指令", "prompt", { long: true, value: hook?.prompt, required: true }),
        ],
        hook ? "保存修改" : "创建 Webhook",
        async (data) => {
          if (hook) {
            await ctx.action("hooks/edit", { id: hook.id, ...data });
          } else {
            await showSecret(await ctx.post("hooks/add", data));
          }
        },
      ),
    );
  }
  edit();
  const list = rows(
    ctx.state.hooks,
    (hook) =>
      item(hook.title, (hook.enabled ? "已启用" : "已停用") + " · " + hook.prompt, [
        button("编辑", () => edit(hook)),
        button(hook.enabled ? "停用" : "启用", () =>
          ctx.action("hooks/" + (hook.enabled ? "disable" : "enable"), { id: hook.id }),
        ),
        button("轮换地址", async () => showSecret(await ctx.post("hooks/rotate", { id: hook.id }))),
        button("删除", () => ctx.action("hooks/remove", { id: hook.id })),
      ]),
    "暂无 Webhook。",
  );
  return group("split", section("Webhook", list), section("配置触发器", editor));
}
