import {
  field,
  form,
  group,
  element,
  section,
  panel,
  item,
  button,
  rows,
  link,
  badge,
  notify,
} from "../ui.js";

export function feishu(ctx) {
  const { workspace, settings: config } = ctx.state;
  const connectionList = group("");
  function connections() {
    const labels = {
      connected: "已连接",
      connecting: "连接中",
      reconnecting: "重连中",
      disconnected: "已断开",
      ready: "客户端已就绪",
    };
    const entries = ctx.state.connections || [];
    connectionList.replaceChildren(
      rows(
        entries,
        (b) => {
          const value = b.state?.state || b.state;
          return group(
            "item row-title",
            element("strong", "", b.id),
            badge(
              labels[value] || value || "待连接",
              value === "connected" || value === "ready" ? "green" : "amber",
            ),
          );
        },
        config ? "当前没有启用的连接。" : "机器人连接由宿主管理。",
      ),
    );
  }
  connections();
  ctx.onUpdate(connections);
  const live = panel("长连接状态", "plane", connectionList, button("刷新", ctx.reload));
  if (!config) {
    return group(
      "stack",
      live,
      section(
        "飞书机器人",
        element("p", "detail", "在 llm-proxy 的 Remote Bridge 中管理机器人凭据和授权名单。"),
        link("打开宿主工作台 ↗", ctx.state.hostSettingsUrl || "/"),
      ),
      testPanel(ctx, ctx.state.connections || []),
    );
  }
  const botEditor = element("div");
  function edit(bot = {}) {
    botEditor.replaceChildren(
      form(
        [
          field("机器人标识", "id", { required: true, value: bot.id }),
          field("App ID", "appId", { required: true, value: bot.appId }),
          field("App Secret", "appSecret", {
            type: "password",
            placeholder: bot.hasSecret ? "已保存，留空沿用" : "",
          }),
          field("密钥环境变量名", "appSecretEnv", { value: bot.appSecretEnv }),
          field("工作区", "workspaceId", {
            choices: config.workspaces.map((w) => [w.id, w.id]),
            value: bot.workspaceId || workspace.id,
          }),
          field("授权 open_id（每行一个）", "allowed", {
            long: true,
            value: bot.allowedOpenIds?.join("\n"),
            placeholder: "可先留空保存。私聊机器人，复制它回复的 open_id，填到这里再保存。",
          }),
        ],
        "保存机器人",
        (data) => {
          const { allowed, ...values } = data;
          return ctx.action("settings/save", {
            bots: [
              ...config.bots.filter((b) => b.id !== (bot.id || data.id)),
              {
                ...bot,
                ...values,
                enabled: bot.enabled !== false,
                allowedOpenIds: allowed.split(/\s+/).filter(Boolean),
              },
            ],
          });
        },
      ),
    );
    botEditor.querySelector('[name="id"]').readOnly = !!bot.id;
  }
  edit();
  const list = rows(
    config.bots,
    (bot) =>
      item(
        bot.id,
        bot.appId + " · " + bot.workspaceId + " · " + (bot.enabled === false ? "已停用" : "已启用"),
        [
          button(bot.enabled === false ? "启用" : "停用", () =>
            ctx.action("settings/save", {
              bots: config.bots.map((b) =>
                b.id === bot.id ? { ...b, enabled: b.enabled === false } : b,
              ),
            }),
          ),
          button("编辑", () => edit(bot)),
          button("移除", () =>
            ctx.action("settings/save", { bots: config.bots.filter((b) => b.id !== bot.id) }),
          ),
        ],
      ),
    "尚未连接飞书机器人。",
  );

  const panels = [
    live,
    group("split", section("机器人列表", list), section("飞书机器人", botEditor)),
  ];
  const test = testPanel(ctx, config.bots);
  return group("stack", ...panels, test);
}

function testPanel(ctx, bots) {
  const eligible = bots.filter(
    (b) =>
      b.workspaceId === ctx.state.workspace.id && b.enabled !== false && b.allowedOpenIds?.length,
  );
  if (ctx.state.canTestBot && eligible.length) {
    const bot = field("测试机器人", "botId", { choices: eligible.map((b) => [b.id, b.id]) });
    const recipient = field("已授权接收人", "openId", { choices: [] });
    const replace = () =>
      recipient.lastChild.replaceChildren(
        ...eligible
          .find((b) => b.id === bot.lastChild.value)
          .allowedOpenIds.map((id) => new Option(id, id)),
      );
    replace();
    bot.addEventListener("change", replace);
    return section(
      "测试私聊",
      form([bot, recipient], "发送测试消息", async (data) => {
        await ctx.post("feishu/test", data);
        notify("测试消息已发送");
      }),
    );
  }
  return null;
}
