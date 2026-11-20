import { icon } from "./components/icon.js";

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

export function notify(text, error = false) {
  const message = document.querySelector("#feedback");
  message.hidden = !text;
  message.classList.toggle("error", error);
  message.textContent = text;
}

export function handle(action) {
  return async (event) => {
    try {
      await action(event);
    } catch (error) {
      notify(error.message, true);
    }
  };
}

export function button(title, action, primary = false) {
  const node = element("button", primary ? "primary" : "", title);
  node.type = "button";
  node.addEventListener("click", handle(action));
  return node;
}

export function group(className, ...children) {
  const box = element("div", className);
  box.append(...children.filter(Boolean));
  return box;
}

export function section(title, ...children) {
  const panel = element("section");
  panel.append(element("h2", "", title), ...children);
  return panel;
}

export function field(label, name, options = {}) {
  const node = element("label", "", label);
  let input;
  if (options.choices) {
    input = element("select");
    for (const [value, title] of options.choices) {
      input.add(new Option(title, value));
    }
  } else if (options.long) {
    input = element("textarea");
  } else {
    input = element("input");
    input.type = options.type || "text";
  }
  input.name = name;
  input.value = options.value ?? options.choices?.[0]?.[0] ?? "";
  input.required = !!options.required;
  if (options.placeholder) {
    input.placeholder = options.placeholder;
  }
  node.append(input);
  return node;
}

export function form(fields, submitText, submit) {
  const node = element("form");
  const save = element("button", "primary", submitText);
  save.type = "submit";
  node.append(...fields, save);
  node.addEventListener(
    "submit",
    handle(async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        await submit(Object.fromEntries(new FormData(node)), node);
      } finally {
        save.disabled = false;
      }
    }),
  );
  return node;
}

export function item(title, detail, actions = []) {
  return group(
    "item",
    element("h3", "", title),
    detail && element("p", "detail", detail),
    actions.length && group("actions", ...actions),
  );
}

export function rows(entries, render, empty) {
  return entries.length ? group("", ...entries.map(render)) : element("p", "empty", empty);
}

export const time = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
export const statusName = (value) =>
  ({
    queued: "排队中",
    running: "运行中",
    succeeded: "完成",
    failed: "失败",
    interrupted: "中断",
    cancelled: "已取消",
    timed_out: "已超时",
    pending: "待批准",
    active: "启用",
    paused: "暂停",
    done: "完成",
  })[value] || value;

export function link(title, href) {
  const node = element("a", "text-link", title);
  node.href = href;
  return node;
}

export function badge(label, tone = "neutral") {
  return element("span", "badge " + tone, label);
}

export function panel(title, symbol, body, action) {
  const box = element("section", "panel");
  const heading = element("h2", "", title);
  heading.prepend(icon(symbol));
  box.append(group("panel-heading", heading, action), body);
  return box;
}

export function modelField(title, name, value) {
  const node = field(title, name, { value, placeholder: "跟随默认模型" });
  node.lastChild.setAttribute("list", "model-choices");
  return node;
}

export function modelChoices(workspace) {
  const list = element("datalist");
  list.id = "model-choices";
  const values = [
    workspace.model,
    workspace.auxiliaryModel,
    workspace.visionModel,
    ...(workspace.workers || []).map((w) => w.model),
    "sonnet",
    "opus",
    "haiku",
  ];
  for (const value of new Set(values.filter(Boolean))) list.append(new Option(value));
  return list;
}
