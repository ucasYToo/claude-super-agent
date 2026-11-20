import fs from "node:fs";
import path from "node:path";

export function claudeArguments(lines: string[]) {
  if (!Array.isArray(lines) || lines.length > 3) throw Error("每个 Claude 选项使用一行");
  const args: string[] = [];
  for (const line of lines) {
    const match = typeof line === "string" && /^(--[a-z-]+)\s+([^\s]+)$/.exec(line.trim());
    if (!match) throw Error("Claude 选项格式为 --名称 值");
    const [, key, value] = match;
    const allowed =
      key === "--effort"
        ? /^(low|medium|high|xhigh|max)$/.test(value)
        : key === "--fallback-model"
          ? /^[a-zA-Z0-9][\w.,:/[\]-]{0,159}$/.test(value)
          : key === "--max-budget-usd" &&
            /^\d+(?:\.\d+)?$/.test(value) &&
            Number(value) > 0 &&
            Number.isFinite(Number(value));
    if (!allowed || args.includes(key)) throw Error("Claude 选项或取值无效：" + key);
    args.push(key, value);
  }
  return args;
}

export function executableName(value: unknown) {
  if (typeof value !== "string") throw Error("Claude 命令需要是可执行文件");
  const name = value.trim() || "claude";
  if (name.includes("\0")) throw Error("Claude 命令无效");
  const files = path.isAbsolute(name)
    ? [name]
    : /^[A-Za-z0-9][\w.-]*$/.test(name)
      ? (process.env.PATH || "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir, name))
      : [];
  for (const file of files) {
    if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      fs.accessSync(file, fs.constants.X_OK);
      return name;
    }
  }
  throw Error("找不到可执行文件，请填写本机已安装的 Claude CLI 路径");
}
