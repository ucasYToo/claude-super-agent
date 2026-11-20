import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

import { Workspace } from "../agent/contracts";
import { atomicWrite } from "../storage/files";
import { workspacePath } from "./initialize";

export function syncWorkerRoster(workspace: Workspace) {
  const file = workspacePath(workspace.cwd, ".superagent/jobs/WORKERS.md");
  if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return true;
  const key = createHash("sha256").update(workspace.id).digest("hex").slice(0, 16);
  const start = "<!-- superagent-workers " + key + " -->";
  const end = "<!-- /superagent-workers " + key + " -->";
  const workers = workspace.workers || [];
  const clean = (s: string) => s.replace(/[\r\n<>]/g, " ").trim();
  const roster = [
    start,
    "## " + clean(workspace.id),
    "",
    "- default · " + clean(workspace.model || "主模型") + " · 通用任务",
    ...workers.map(
      (w) =>
        "- " +
        clean(w.name) +
        " · " +
        clean(w.model || workspace.model || "主模型") +
        " · " +
        clean(w.purpose),
    ),
    end,
  ].join("\n");
  let unlock;
  try {
    unlock = lockfile.lockSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return false;
    throw error;
  }
  try {
    const before = fs.readFileSync(file, "utf8");
    if (
      !before.includes("<!-- superagent-workers ") &&
      before !==
        fs.readFileSync(
          path.resolve(__dirname, "../../templates/workspace/jobs/WORKERS.md"),
          "utf8",
        )
    )
      return true;
    const a = before.indexOf(start);
    const b = before.indexOf(end, Math.max(0, a));
    if ((a >= 0 && b < 0) || (a < 0 && b >= 0)) return true;
    const after =
      a < 0
        ? before + "\n" + roster + "\n"
        : before.slice(0, a) + roster + before.slice(b + end.length);
    if (before !== after) atomicWrite(file, after);
    return true;
  } finally {
    unlock();
  }
}
