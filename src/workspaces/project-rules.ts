import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { workspacePath } from "./initialize";

export function readProjectRules(cwd: string) {
  const file = workspacePath(cwd, "CLAUDE.md");
  if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    return "";
  }
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(128 * 1024);
    return buffer.toString("utf8", 0, fs.readSync(fd, buffer));
  } finally {
    fs.closeSync(fd);
  }
}

export function parentRulePatterns(cwd: string) {
  const patterns: string[] = [];
  const userConfig = path.resolve(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  );
  for (let dir = path.dirname(cwd); dir !== cwd; dir = path.dirname(dir)) {
    const literal = dir.replace(/[\\*?\[\]{}()!+@]/g, "\\$&");
    for (const file of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/rules/**"]) {
      if (file.startsWith(".claude/") && path.join(dir, ".claude") === userConfig) continue;
      patterns.push(path.join(literal, file));
    }
    if (dir === path.dirname(dir)) break;
  }
  return patterns;
}
