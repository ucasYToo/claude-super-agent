import { button, element, group, notify } from "../ui.js";

export function directoryField(ctx, label) {
  const input = label.lastChild;
  const picker = group("directory-picker");
  picker.hidden = true;
  let version = 0;
  async function browse(cwd) {
    const request = ++version;
    const directory = await ctx.get("directories", { cwd });
    if (request !== version) return;
    picker.hidden = false;
    const path = element("code", "", directory.cwd);
    const choices = group(
      "directory-list",
      ...directory.names.map((name) =>
        button(name, () => browse(directory.cwd.replace(/\/$/, "") + "/" + name)),
      ),
    );
    picker.replaceChildren(
      path,
      group(
        "actions",
        button("上一级", () => browse(directory.parent)),
        button("选择此目录", () => {
          input.value = directory.cwd;
          picker.hidden = true;
        }),
        button("关闭", () => {
          picker.hidden = true;
        }),
      ),
      choices,
    );
  }
  const launch = button("浏览目录", async () => {
    try {
      await browse(input.value || ctx.state.workspace.cwd);
    } catch (error) {
      notify(error.message, true);
    }
  });
  return group("directory-field", label, launch, picker);
}
