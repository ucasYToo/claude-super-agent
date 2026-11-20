import { element, button, handle, notify } from "./ui.js";
import { icon } from "./components/icon.js";
import { workbench, history } from "./pages/workbench.js";
import { workers } from "./pages/workers.js";
import { memory } from "./pages/memory.js";
import { feishu } from "./pages/feishu.js";
import { schedules, webhooks } from "./pages/automations.js";
import { settings } from "./pages/settings.js";

const pages = {
  workbench: ["运行概览", workbench, "overview"],
  workers: ["后台 Worker", workers, "workers"],
  schedules: ["定时任务", schedules, "clock"],
  hooks: ["Webhook", webhooks, "hook"],
  memory: ["核心记忆", memory, "book"],
  history: ["消息记录", history, "history"],
  feishu: ["飞书", feishu, "plane"],
  settings: ["工作区", settings, "folder"],
};
const content = document.querySelector("#content");
const workspace = document.querySelector("#workspace");
const route = document.querySelector("#route");
let state;
let updateView;
let events;
let scope = {};
let sequence = 0;

function url(endpoint, query = {}) {
  const target = new URL("./api/" + endpoint, document.baseURI);
  for (const [key, value] of Object.entries({ ...scope, ...query })) {
    if (value !== "" && value != null) {
      target.searchParams.set(key, value);
    }
  }
  return target;
}

async function fetchJson(endpoint, options, query) {
  const response = await fetch(url(endpoint, query), options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(error.error || "HTTP " + response.status);
  }
  return response.json();
}

const get = (endpoint, query) => fetchJson(endpoint, {}, query);
const post = (endpoint, body = {}) =>
  fetchJson(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function action(endpoint, body) {
  await post(endpoint, body);
  await reload();
  notify("已保存");
}

function replaceOptions(select, options, value) {
  select.replaceChildren(...options.map(([id, label]) => new Option(label, id)));
  select.value = value;
}

async function reload() {
  const version = ++sequence;
  const snapshot = await get("state");
  if (version !== sequence) {
    return;
  }
  state = snapshot;
  scope = { workspace: state.workspace.id, route: state.route };
  replaceOptions(
    workspace,
    state.workspaces.map((id) => [id, id]),
    scope.workspace,
  );
  replaceOptions(
    route,
    state.routes.map((r) => [r.id, r.label]),
    scope.route,
  );
  const key = location.hash.slice(1) in pages ? location.hash.slice(1) : "workbench";
  document.querySelector("#heading").textContent = pages[key][0];
  document.title = pages[key][0] + " · Super Agent";
  document.querySelector("#page-detail").textContent = state.workspace.cwd;
  document.querySelector("#feedback").hidden = true;
  document
    .querySelectorAll("nav button")
    .forEach((node) =>
      node.setAttribute("aria-current", node.dataset.key === key ? "page" : "false"),
    );
  updateView = null;
  let refreshView;
  const view = await pages[key][1]({
    get,
    post,
    action,
    reload,
    get state() {
      return state;
    },
    onUpdate: (fn) => {
      refreshView = fn;
    },
  });
  if (version !== sequence) {
    return;
  }
  updateView = refreshView;
  content.replaceChildren(view);
  if (events?.url !== url("events").href) {
    let received = 0;
    events?.close();
    events = new EventSource(url("events"));
    const connection = document.querySelector("#connection");
    events.onopen = () => {
      connection.textContent = "服务在线";
      connection.dataset.online = "true";
    };
    events.onerror = () => {
      connection.textContent = "重新连接中";
      connection.dataset.online = "false";
    };
    events.onmessage = handle(async () => {
      if (!updateView) {
        return;
      }
      const version = sequence;
      const message = ++received;
      const snapshot = await get("state");
      if (message === received && version === sequence && updateView) {
        state = snapshot;
        await updateView();
      }
    });
  }
}

for (const [key, [title, , symbol]] of Object.entries(pages)) {
  const link = button(title, () => {
    location.hash = key;
  });
  link.prepend(icon(symbol));
  link.dataset.key = key;
  document.querySelector("nav").append(link);
}
workspace.addEventListener(
  "change",
  handle(async () => {
    scope = { workspace: workspace.value };
    await reload();
  }),
);
route.addEventListener(
  "change",
  handle(async () => {
    scope.route = route.value;
    await reload();
  }),
);
window.addEventListener("hashchange", handle(reload));
reload().catch((error) => notify(error.message, true));
