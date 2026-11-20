import fs from "node:fs";
import path from "node:path";

const templates = path.resolve(__dirname, "../../templates/workspace");

const starterFiles = [
  ["CLAUDE.md", "CLAUDE.md"],
  ["SOUL.md", "SOUL.md"],
  ["memory/MEMORY.md", "memory/MEMORY.md"],
  ["memory/core/profile.md", "memory/core/profile.md"],
  ["memory/notes/topics.md", "memory/notes/topics.md"],
  ["skills/superagent-jobs/SKILL.md", ".claude/skills/superagent-jobs/SKILL.md"],
  ["jobs/WORKERS.md", ".superagent/jobs/WORKERS.md"],
] as const;

// Existing links belong to the project. Leave the link and its destination alone.
export function workspacePath(cwd: string, relative: string): string | undefined {
  let current = cwd;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return undefined;
    }
  }
  return current;
}

export function initializeWorkspace(cwd: string) {
  const root = fs.realpathSync(cwd);
  const journal = workspacePath(root, "memory/journal");
  if (journal) {
    fs.mkdirSync(journal, { recursive: true, mode: 0o700 });
  }
  for (const [source, destination] of starterFiles) {
    const file = workspacePath(root, destination);
    if (!file) {
      continue;
    }
    const existing = fs.statSync(file, { throwIfNoEntry: false });
    if (existing?.isFile()) {
      continue;
    }
    if (existing) {
      throw Error("工作区模板路径需要是文件：" + file);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      fs.copyFileSync(path.join(templates, source), file, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}
