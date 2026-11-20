import fs from "node:fs";

import { WorkerConfig, Workspace, required } from "../agent/contracts";

export function validateWorker(input: WorkerConfig, workspace: Workspace) {
  if (
    typeof input.name !== "string" ||
    !/^[a-z0-9-]{1,20}$/.test(input.name) ||
    input.name === "default"
  ) {
    throw Error("无效或保留的 Worker 名");
  }
  required(input.purpose, "用途", 1000);
  if (input.cwd) {
    const cwd = fs.realpathSync(input.cwd);
    if (
      ![workspace.cwd, ...(workspace.allowedCwds ?? [])].some((dir) => fs.realpathSync(dir) === cwd)
    ) {
      throw Error("工作目录未授权");
    }
  }
  if (
    input.tools &&
    (!Array.isArray(input.tools) ||
      input.tools.some(
        (t) =>
          !["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebSearch", "WebFetch"].includes(t),
      ))
  ) {
    throw Error("工具列表无效");
  }
}
