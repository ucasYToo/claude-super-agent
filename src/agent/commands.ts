import type { Scope } from "./contracts";
import type { SuperAgent } from "./super-agent";

type SessionCommand = "/new" | "/restart" | "/stop";

export function runControlCommand(
  agent: SuperAgent,
  scope: Scope,
  input: string,
  changeSession: (command: SessionCommand) => string,
): string | undefined {
  const [command, argument] = input.trim().split(/\s+/);
  switch (command) {
    case "/help":
      return "/status · /jobs · /cancel 编号 · /tasks · /approve 编号 · /reject 编号 · /new · /restart · /stop";
    case "/status":
      return JSON.stringify(agent.status());
    case "/jobs": {
      const all = agent.listJobs(scope);
      const active = all.filter((j) => j.state === "running" || j.state === "queued");
      const jobs = [
        ...active,
        ...all.filter((j) => j.state !== "queued" && j.state !== "running").slice(0, 5),
      ];
      return (
        jobs.map((job) => "#" + job.id + " " + job.title + " · " + job.state).join("\n") ||
        "暂无后台任务"
      );
    }
    case "/cancel":
      return JSON.stringify(agent.cancelJob(scope, Number(argument)));
    case "/tasks":
      return (
        agent.schedules
          .schedules(scope)
          .map((task) => "#" + task.id + " " + task.title + " · " + task.state)
          .join("\n") || "暂无定时任务"
      );
    case "/approve":
    case "/reject":
      agent.schedules.scheduleAction(scope, Number(argument), command.slice(1));
      return "已处理 #" + argument;
    case "/new":
    case "/restart":
    case "/stop":
      return changeSession(command);
    default:
      return undefined;
  }
}
