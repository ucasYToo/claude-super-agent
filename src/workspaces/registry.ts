import fs from "node:fs";

import { Workspace, WorkerConfig, Options } from "../agent/contracts";
import { Store } from "../storage/database";
import { validateWorker } from "../workers/worker-config";
import { syncWorkerRoster } from "./worker-roster";
import { initializeWorkspace } from "./initialize";

import { claudeArguments } from "../runtime/claude/options";

export class WorkspaceRegistry {
  private initialized = new Map<string, string>();

  constructor(
    private db: Store,
    private options: Options,
  ) {}

  get(id: string): Workspace {
    const base = this.options.resolveWorkspace
      ? this.options.resolveWorkspace(id)
      : this.options.workspaces?.find((w) => w.id === id);
    if (!base) {
      throw Error("工作区不存在或已停用");
    }
    const overrides = this.db.get<Partial<Workspace>>("workspace:" + id, {});
    const cwd = fs.realpathSync(base.cwd);
    const workspace = { ...base, ...overrides, cwd, id };
    const signature = JSON.stringify([cwd, workspace.model, workspace.workers]);
    if (this.initialized.get(id) !== signature) {
      initializeWorkspace(cwd);
      if (syncWorkerRoster(workspace)) this.initialized.set(id, signature);
    }
    return workspace;
  }

  updateWorkspace(id: string, patch: Partial<Workspace>) {
    const current = this.get(id);
    const next = { ...current };
    if (patch.model !== undefined) {
      next.model = String(patch.model).slice(0, 160);
    }
    if (patch.auxiliaryModel !== undefined) {
      next.auxiliaryModel = String(patch.auxiliaryModel).slice(0, 160);
    }
    if (patch.visionModel !== undefined) {
      next.visionModel = String(patch.visionModel).slice(0, 160);
    }
    if (patch.timezone !== undefined) {
      new Intl.DateTimeFormat("en", { timeZone: patch.timezone });
      next.timezone = patch.timezone;
    }
    if (patch.consolidateAt !== undefined) {
      if (patch.consolidateAt !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.consolidateAt)) {
        throw Error("使用 HH:mm 或留空");
      }
      next.consolidateAt = patch.consolidateAt;
    }
    if (patch.turnTimeoutMinutes !== undefined) {
      const n = Number(patch.turnTimeoutMinutes);
      if (!Number.isFinite(n) || n < 1 || n > 180) {
        throw Error("超时范围 1 至 180 分钟");
      }
      next.turnTimeoutMinutes = n;
    }
    if (patch.claudeOptions !== undefined) {
      claudeArguments(patch.claudeOptions);
      next.claudeOptions = patch.claudeOptions;
    }
    if (patch.excludeParentRules !== undefined) {
      if (typeof patch.excludeParentRules !== "boolean") throw Error("上级规则设置无效");
      next.excludeParentRules = patch.excludeParentRules;
    }
    const { model, auxiliaryModel, visionModel, timezone, consolidateAt, turnTimeoutMinutes } =
      next;
    this.db.set("workspace:" + id, {
      ...this.db.get("workspace:" + id, {}),
      model,
      auxiliaryModel,
      visionModel,
      timezone,
      consolidateAt,
      turnTimeoutMinutes,
      excludeParentRules: next.excludeParentRules,
      claudeOptions: next.claudeOptions,
    });
    return this.get(id);
  }

  setWorker(id: string, input: WorkerConfig, remove = false) {
    const workspace = this.get(id);
    const workers = (workspace.workers || []).filter((w) => w.name !== input.name);
    if (remove && input.name === "default") {
      throw Error("default 是保留名");
    }
    if (!remove) {
      validateWorker(input, workspace);
      workers.push(input);
    }
    if (workers.length > 10) {
      throw Error("每个工作区最多 10 个 Worker");
    }
    this.db.set("workspace:" + id, { ...this.db.get("workspace:" + id, {}), workers });
    this.get(id);
    return workers;
  }
}
