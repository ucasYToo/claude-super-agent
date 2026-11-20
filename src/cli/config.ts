import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Config } from "../agent/contracts";
import { atomicWrite } from "../storage/files";
import { initializeWorkspace } from "../workspaces/initialize";

export function initialize(dir: string, cwd?: string): Config {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "config.json");
  if (!fs.existsSync(file)) {
    const work = path.resolve(cwd || path.join(os.homedir(), "super-agent-workspace"));
    fs.mkdirSync(work, { recursive: true });
    initializeWorkspace(work);
    atomicWrite(
      file,
      JSON.stringify(
        { workspaces: [{ id: "default", cwd: work, workers: [] }], feishu: { bots: [] } },
        null,
        2,
      ),
    );
  }
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Config;
  if (!cfg.workspaces?.length) {
    throw Error("至少配置一个工作区");
  }
  return cfg;
}

export function initializeWorkspaces(dir: string, cwd?: string) {
  const config = initialize(dir, cwd);
  if (cwd) {
    fs.mkdirSync(path.resolve(cwd), { recursive: true, mode: 0o700 });
  }
  const directories = cwd
    ? [path.resolve(cwd)]
    : config.workspaces.map((workspace) => workspace.cwd);
  for (const directory of directories) {
    initializeWorkspace(directory);
  }
  return config;
}

export function openUrl(url: string) {
  const p = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
    stdio: "ignore",
    detached: true,
  });
  p.on("error", () => {});
  p.unref();
}
