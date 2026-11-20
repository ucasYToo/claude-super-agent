import fs from "node:fs";
import path from "node:path";

import { contained } from "../storage/files";

export function listDirectories(directory: string) {
  if (!path.isAbsolute(directory)) throw Error("请选择本机绝对路径");
  const cwd = fs.realpathSync(directory);
  const names = fs
    .readdirSync(cwd, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  return { cwd, parent: path.dirname(cwd), names };
}

export function readJobEvents(cwd: string, id: number) {
  const file = contained(cwd, ".superagent/jobs/" + id + "/events.jsonl");
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return [];
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, 32768));
    const count = fs.readSync(fd, buffer, 0, buffer.length, stat.size - buffer.length);
    return buffer
      .toString("utf8", 0, count)
      .split("\n")
      .slice(-151)
      .flatMap((line) => {
        try {
          const { time, event } = JSON.parse(line);
          return typeof event === "string" && Number.isFinite(time) ? [{ time, event }] : [];
        } catch {
          return [];
        }
      });
  } finally {
    fs.closeSync(fd);
  }
}
