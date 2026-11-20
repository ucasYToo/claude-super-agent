import type { Schedules } from "../automation/schedules";
import type { Memory } from "../memory/files";
import type { ToolServer } from "../runtime/mcp/tool-server";
import type { TurnRecord } from "../storage/records";
import type { WorkerScheduler } from "../workers/scheduler";
import type { WorkspaceRegistry } from "../workspaces/registry";
import type { Route, WorkerConfig, Workspace } from "./contracts";

function allowedTools(turn: TurnRecord) {
  switch (turn.source) {
    case "external":
      return [];
    case "progress":
      return ["updateEta", "cancelJob"];
    case "review":
      return turn.depth < 3 ? ["dispatchJob"] : [];
    default:
      return [
        "dispatchJob",
        "cancelJob",
        "configureWorker",
        "proposeSchedule",
        "readMemory",
        "writeSoul",
      ];
  }
}

interface ToolServices {
  server: ToolServer;
  jobs: WorkerScheduler;
  workspaces: WorkspaceRegistry;
  schedules: Schedules;
  memory: Memory;
}

export class TurnTools {
  constructor(private services: ToolServices) {}

  grant(turn: TurnRecord, route: Route, workspace: Workspace, signal: AbortSignal) {
    const names = allowedTools(turn);
    if (!names.length) {
      return;
    }

    const { server, jobs, workspaces, schedules, memory } = this.services;
    return server.issue({
      names,
      call(name, args) {
        signal.throwIfAborted();
        switch (name) {
          case "dispatchJob":
            return jobs.dispatch(turn, args);
          case "updateEta":
            return jobs.updateEta(turn, Number(args.eta));
          case "cancelJob": {
            const jobId = Number(args.id);
            if (turn.source === "progress" && turn.job !== jobId) {
              throw Error("只能操作当前任务");
            }
            return jobs.cancel(route.scope, jobId);
          }
          case "readMemory":
            return memory.read(route.scope, String(args.name));
          case "writeSoul":
            memory.write(route.scope, "SOUL.md", String(args.text));
            return { saved: true };
          case "configureWorker":
            return workspaces.setWorker(
              workspace.id,
              args as unknown as WorkerConfig,
              !!args.remove,
            );
          case "proposeSchedule":
            return {
              pendingSchedule: schedules.addSchedule(
                route,
                { ...args, tz: workspace.timezone },
                true,
              ),
            };
          default:
            throw Error("未知工具 " + name);
        }
      },
    });
  }
}
