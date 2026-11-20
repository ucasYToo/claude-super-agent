import { jobList } from "../components/jobs.js";
import { icon } from "../components/icon.js";
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
  panel,
  badge,
  link,
} from "../ui.js";

const sourceLabels = {
  feishu: "飞书",
  web: "Web",
  review: "任务验收",
  progress: "进度",
  worker: "后台任务",
  schedule: "定时任务",
  hook: "Webhook",
  external: "外部材料",
  error: "错误",
  control: "会话控制",
};
function messages(container, history) {
  container.replaceChildren(
    ...history
      .slice()
      .reverse()
      .map((message) => {
        const line = element("article", "message " + message.direction);
        line.append(
          element(
            "time",
            "",
            (message.direction === "in" ? "收到" : "助手") +
              " · " +
              (sourceLabels[message.source] || message.source) +
              " · " +
              time(message.created) +
              (message.status === "failed" ? " · 失败" : ""),
          ),
          element("p", "bodytext", message.text),
        );
        return line;
      }),
  );
  if (!history.length) {
    container.append(
      group(
        "empty chat-empty",
        icon("chat"),
        element("h3", "", "开始对话"),
        element("p", "", "输入问题，或附上一张图片。"),
      ),
    );
  }
  container.scrollTop = container.scrollHeight;
}

export async function workbench(ctx) {
  const feed = element("div", "feed");
  messages(feed, await ctx.get("history", { conversation: "current" }));
  const compose = form(
    [field("消息", "text", { long: true }), field("附加图片", "attachment", { type: "file" })],
    "发送",
    async (data, form) => {
      const file = data.attachment;
      let image;
      if (file.size) {
        if (file.size > 5 * 1024 * 1024) {
          throw Error("图片需要在 5 MB 以内");
        }
        image = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = () => reject(Error("图片读取失败"));
          reader.readAsDataURL(file);
        });
      }
      await ctx.post("chat/send", { text: data.text, image, messageId: cryptoId() });
      form.reset();
      messages(feed, await ctx.get("history", { conversation: "current" }));
    },
  );
  compose.elements.attachment.accept = "image/png,image/jpeg,image/gif,image/webp";
  compose.className = "composer";
  compose.elements.text.placeholder = "给助手发消息…";
  compose.elements.text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) compose.requestSubmit();
  });
  const attach = compose.elements.attachment;
  const fileLabel = attach.parentElement;
  const attachmentName = element("span", "", "附加图片");
  fileLabel.firstChild.remove();
  fileLabel.prepend(attachmentName);
  fileLabel.className = "attach";
  attach.addEventListener(
    "change",
    () => (attachmentName.textContent = attach.files[0]?.name || "附加图片"),
  );
  compose.addEventListener("reset", () => (attachmentName.textContent = "附加图片"));
  const controls = group(
    "actions",
    ...[
      ["中断本轮", "/stop"],
      ["新会话", "/new"],
      ["重启主会话", "/restart"],
    ].map(([title, text]) =>
      button(title, async () => {
        await ctx.post("chat/send", { text, messageId: cryptoId() });
        messages(feed, await ctx.get("history", { conversation: "current" }));
      }),
    ),
  );
  const labels = {
    idle: "空闲",
    running: "处理中",
    paused: "连续失败，等待恢复",
    consolidating: "正在整理记忆",
  };
  const summary = group("session-banner");
  const metrics = group("metrics");
  function renderStatus() {
    const state = ctx.state;
    const details = state.session;
    const active = state.jobs.filter((job) => job.state === "running").length;
    const queued = state.jobs.filter((job) => job.state === "queued").length;
    const scheduled = state.tasks.filter((task) => task.state === "active").length;
    summary.replaceChildren(
      group(
        "session-top",
        group("session-name", icon("terminal"), element("h2", "", "主会话")),
        badge(labels[state.sessionStatus] || state.sessionStatus, "live"),
      ),
      element("p", "session-model", state.workspace.model || "Claude 默认模型"),
      element(
        "p",
        "session-info",
        [
          details.pid && "PID " + details.pid,
          details.sessionId
            ? "会话 " + details.sessionId
            : details.pid
              ? "会话启动中"
              : "下一条消息将启动 Claude 会话",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      controls,
    );
    const values = [
      ["运行中任务", active, "#workers", "workers"],
      ["排队任务", queued, "#workers", "clock"],
      ["会话排队", details.queued, "#history", "chat"],
      ["已启用定时任务", scheduled, "#schedules", "clock"],
    ];
    metrics.replaceChildren(
      ...values.map(([label, value, href, symbol]) => {
        const tile = link("", href);
        tile.className = "metric";
        tile.append(
          group("metric-label", icon(symbol), element("span", "", label)),
          element("strong", "", value),
        );
        return tile;
      }),
    );
  }
  renderStatus();
  const jobs = group("", jobList(ctx));
  let jobSnapshot = JSON.stringify(ctx.state.jobs);
  ctx.onUpdate(async () => {
    messages(feed, await ctx.get("history", { conversation: "current" }));
    renderStatus();
    const snapshot = JSON.stringify(ctx.state.jobs);
    if (jobSnapshot !== snapshot) {
      jobSnapshot = snapshot;
      jobs.replaceChildren(jobList(ctx));
    }
  });
  return group(
    "stack",
    group("overview-summary", summary, metrics),
    group(
      "overview-columns",
      panel("调试对话", "chat", group("chat-panel", feed, compose), link("消息记录 ↗", "#history")),
      panel("后台任务", "workers", jobs, link("查看 Worker ↗", "#workers")),
    ),
  );
}

function cryptoId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function history(ctx) {
  const feed = element("div", "feed");
  const refresh = async (filters) => messages(feed, await ctx.get("history", filters));
  const sources = [
    ["", "全部来源"],
    ["feishu", "飞书"],
    ["web", "Web"],
    ["worker", "后台任务"],
    ["review", "任务验收"],
    ["schedule", "定时任务"],
    ["hook", "Webhook"],
    ["external", "外部材料"],
    ["error", "错误"],
  ];
  const filters = form(
    [
      field("搜索文本", "q"),
      field("来源", "source", { choices: sources }),
      field("状态", "status", {
        choices: [
          ["", "全部"],
          ["failed", "失败"],
        ],
      }),
      field("开始时间", "from", { type: "datetime-local" }),
      field("结束时间", "to", { type: "datetime-local" }),
    ],
    "查询",
    (values) => {
      for (const key of ["from", "to"]) {
        if (values[key]) {
          values[key] = new Date(values[key]).getTime();
        }
      }
      return refresh(values);
    },
  );
  await refresh({});
  const quick = group(
    "actions",
    ...[
      ["全部", "", ""],
      ["飞书", "feishu", ""],
      ["Web", "web", ""],
      ["失败", "", "failed"],
    ].map(([label, source, status]) =>
      button(label, () => {
        filters.elements.source.value = source;
        filters.elements.status.value = status;
        filters.requestSubmit();
      }),
    ),
  );
  filters.className = "filters";
  return panel(
    "消息检索",
    "history",
    group("stack", quick, filters, feed),
    button("刷新", () => filters.requestSubmit()),
  );
}
