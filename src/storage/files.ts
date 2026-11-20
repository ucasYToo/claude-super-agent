import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function atomicWrite(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// Keep generated artifacts and memory within their nominated root, including pre-existing symlinks.
export function contained(root: string, relative: string) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((p) => p === ".." || p === ".")) {
    throw Error("非法文件路径");
  }
  let current = fs.realpathSync(root);
  for (const part of relative.split("/").filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw Error("文件路径包含符号链接");
    }
  }
  return current;
}
