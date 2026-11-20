import { badge, button, element, field, form, group, handle, notify, panel, time } from "../ui.js";

export async function memory(ctx) {
  const { workspace } = ctx.state;
  const list = group("file-list");
  const name = field("文件名", "file", { required: true, value: "SOUL.md" });
  const body = field("内容", "text", { long: true });
  const heading = element("h2");
  const save = form([name, body], "保存文件", async (data) => {
    await ctx.post("memory/save", { name: data.file, text: data.text });
    names = (await ctx.get("state")).memory;
    await select(data.file);
    notify("已保存当前用户的记忆");
  });
  const editor = element("section", "file-editor");
  editor.append(heading, save);
  let selected;
  let revision = 0;
  let names = ctx.state.memory;
  async function select(file) {
    const version = ++revision;
    selected = file;
    const fresh = !file;
    const readonly = file === "CLAUDE.md";
    heading.textContent = readonly ? "CLAUDE.md · 只读" : file || "新建记忆文件";
    name.hidden = !fresh;
    name.lastChild.value = file || "notes/";
    body.lastChild.readOnly = readonly;
    body.lastChild.value = "";
    const submit = save.querySelector("button[type=submit]");
    submit.hidden = readonly;
    submit.disabled = !fresh;
    for (const node of list.querySelectorAll("button"))
      node.setAttribute("aria-pressed", String(file === node.dataset.file));
    if (fresh) {
      name.lastChild.focus();
      return;
    }
    const result = await ctx.get("memory", { name: file });
    if (version !== revision) return;
    body.lastChild.value = result.text;
    submit.disabled = readonly;
    drawFiles();
  }
  function drawFiles() {
    list.replaceChildren();
    const groups = new Map(
      ["工作区", "memory", "memory/core", "memory/notes", "memory/journal"].map((dir) => [dir, []]),
    );
    for (const file of ["CLAUDE.md", ...names]) {
      const parts = file.split("/");
      const dir =
        file === "MEMORY.md" ? "memory" : parts.length === 1 ? "工作区" : "memory/" + parts[0];
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(file);
    }
    for (const [dir, files] of groups) {
      list.append(element("h3", "file-group", dir));
      if (!files.length) list.append(element("span", "detail", "暂无文件"));
      for (const file of files) {
        const node = button(file.split("/").at(-1), () => select(file));
        node.dataset.file = file;
        node.setAttribute("aria-pressed", String(selected === file));
        list.append(node);
      }
    }
  }
  const status = group("detail");
  const drawStatus = () => {
    const { running, last } = ctx.state.consolidation;
    const next = workspace.consolidateAt ?? "03:00";
    status.replaceChildren(
      badge(running ? "整理中" : "空闲", running ? "blue" : "green"),
      element(
        "p",
        "detail",
        next ? "每日 " + next + " · " + (workspace.timezone || "服务器时区") : "自动整理已关闭",
      ),
      element(
        "p",
        "detail",
        last
          ? "上次 " +
              time(last.finished) +
              " · " +
              { success: "成功", empty: "没有新消息", failed: "失败" }[last.outcome] +
              " · " +
              last.records +
              " 条消息"
          : "暂无整理记录",
      ),
    );
  };
  const diff = element("pre", "diff");
  diff.hidden = true;
  const clean = button("立即整理", async () => {
    clean.disabled = true;
    try {
      await ctx.action("memory/consolidate");
    } finally {
      clean.disabled = false;
    }
  });
  const toggle = field("忽略上级目录的 CLAUDE.md 和规则", "exclude", { type: "checkbox" });
  toggle.className = "check";
  toggle.lastChild.checked = !!workspace.excludeParentRules;
  toggle.addEventListener(
    "change",
    handle(async () => {
      try {
        await ctx.post("workspace/save", { excludeParentRules: toggle.lastChild.checked });
        notify("规则将在下一轮调用时生效");
      } catch (error) {
        toggle.lastChild.checked = !toggle.lastChild.checked;
        throw error;
      }
    }),
  );
  drawStatus();
  drawFiles();
  await select("SOUL.md");
  ctx.onUpdate(drawStatus);
  return group(
    "stack",
    group(
      "split equal",
      panel(
        "记忆整理",
        "clock",
        group(
          "stack compact",
          status,
          group(
            "actions",
            clean,
            button("查看改动", async () => {
              diff.textContent = (await ctx.get("memory/diff")).text || "暂无改动";
              diff.hidden = false;
            }),
          ),
          diff,
        ),
      ),
      panel(
        "加载规则",
        "book",
        group(
          "stack compact",
          toggle,
          element("p", "detail", "工作区文件提供公共默认值。在此保存的记忆属于当前用户。"),
        ),
      ),
    ),
    group(
      "memory-grid",
      panel(
        "文件",
        "folder",
        list,
        button("新建", () => select(null)),
      ),
      editor,
    ),
  );
}
