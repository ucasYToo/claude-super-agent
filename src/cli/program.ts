import { fork } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";

import { token, userAction } from "../server/authentication";
import { serve } from "../server/standalone";
import { initialize, initializeWorkspaces, openUrl } from "./config";
import { readPassword } from "./password";

function request(dir: string, api: string, body?: object) {
  return new Promise<any>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: path.join(dir, "control.sock"),
        path: api,
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (b) => (data += b));
        res.on("end", () => {
          try {
            const v = JSON.parse(data);
            if (res.statusCode! >= 400) {
              throw Error(v.error || "请求失败");
            }
            resolve(v);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", () => reject(Error("无法连接运行中的服务")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export async function main() {
  const cli = new Command("claude-super-agent")
    .version("0.2.0")
    .option("--data-dir <dir>", "数据目录", path.join(os.homedir(), ".claude-super-agent"));
  const dir = () => path.resolve(cli.opts().dataDir);
  const print = (v: any) => console.log(JSON.stringify(v, null, 2));
  cli
    .command("init")
    .option("--workspace <directory>")
    .action((options) => {
      const config = initializeWorkspaces(dir(), options.workspace);
      console.log(path.join(dir(), "config.json"));
      if (options.workspace) {
        const cwd = fs.realpathSync(options.workspace);
        console.log("已初始化工作区 " + cwd);
        if (
          !config.workspaces.some((w) => fs.existsSync(w.cwd) && fs.realpathSync(w.cwd) === cwd)
        ) {
          console.log("在服务的「工作区 → 添加工作区」中添加此目录后即可使用。");
        }
      }
    });
  cli
    .command("start")
    .option("--foreground")
    .option("--open")
    .option("--auth")
    .option("--verbose")
    .option("--host <host>", "监听地址", "127.0.0.1")
    .option("-p, --port <port>", "监听端口", "4310")
    .action(async (options) => {
      initialize(dir());
      if (options.foreground) {
        await serve(dir(), options);
        return;
      }
      const logFile = path.join(dir(), "server.log");
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
        fs.renameSync(logFile, logFile + ".1");
      }
      const fd = fs.openSync(logFile, "a", 0o600);
      const child = fork(
        path.join(__dirname, "../../bin/cli.js"),
        [
          "--data-dir",
          dir(),
          "start",
          "--foreground",
          "--host",
          options.host,
          "--port",
          String(options.port),
          ...(options.verbose ? ["--verbose"] : []),
          ...(options.auth ? ["--auth"] : []),
          ...(options.open ? ["--open"] : []),
        ],
        { detached: true, stdio: ["ignore", fd, fd, "ipc"], execArgv: [] },
      );
      fs.closeSync(fd);
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => reject(Error("服务启动失败 " + code + "，请查看 " + logFile)));
        child.once("message", (msg: any) => {
          console.log(msg.url);
          child.unref();
          resolve();
        });
      });
    });
  cli
    .command("status")
    .option("--json")
    .action(async () => print(await request(dir(), "/internal/status")));
  cli.command("stop").action(async () => print(await request(dir(), "/internal/stop", {})));
  cli.command("open").action(async () => openUrl((await request(dir(), "/internal/status")).url));
  cli.command("token").action(() => {
    initialize(dir());
    console.log(token(dir()));
  });
  const jobs = cli.command("jobs");
  jobs
    .command("list")
    .option("--json")
    .option("--workspace <id>")
    .option("--route <id>")
    .action(async (options) =>
      print(
        await request(
          dir(),
          "/api/jobs?" +
            new URLSearchParams(
              Object.fromEntries(Object.entries(options).filter(([k]) => k !== "json")) as Record<
                string,
                string
              >,
            ),
        ),
      ),
    );
  jobs
    .command("cancel <id>")
    .option("--workspace <id>")
    .option("--route <id>")
    .action(async (id, options) =>
      print(
        await request(
          dir(),
          "/api/jobs/" + Number(id) + "/cancel?" + new URLSearchParams(options),
          {},
        ),
      ),
    );
  const task = cli.command("task");
  task
    .command("list")
    .option("--workspace <id>")
    .option("--route <id>")
    .action(async (options) =>
      print((await request(dir(), "/api/state?" + new URLSearchParams(options))).tasks),
    );
  task
    .command("add <prompt>")
    .requiredOption("--title <name>")
    .option("--cron <expr>")
    .option("--at <time>")
    .option("--tz <zone>")
    .option("--workspace <id>")
    .option("--route <id>")
    .action(async (prompt, options) =>
      print(
        await request(
          dir(),
          "/api/tasks/add?" +
            new URLSearchParams({ workspace: options.workspace || "", route: options.route || "" }),
          { ...options, prompt },
        ),
      ),
    );
  for (const action of ["run", "pause", "resume", "approve", "reject", "remove"]) {
    task
      .command(action + " <id>")
      .option("--workspace <id>")
      .option("--route <id>")
      .action(async (id, options) =>
        print(
          await request(dir(), "/api/tasks/" + action + "?" + new URLSearchParams(options), { id }),
        ),
      );
  }
  cli.command("workspace [id]").action(async (id) => {
    if (id) {
      print(await request(dir(), "/api/workspace/select?workspace=" + encodeURIComponent(id), {}));
    } else {
      print(initialize(dir()).workspaces);
    }
  });
  const user = cli.command("user");
  user.command("list").action(() => print(userAction(dir(), "list", "")));
  for (const action of ["add", "passwd", "remove"]) {
    user
      .command(action + " <name>")
      .option("--password-stdin")
      .action(async (name, options) => {
        initialize(dir());
        const password =
          action === "remove" ? "" : await readPassword(Boolean(options.passwordStdin));
        print(userAction(dir(), action, name, password));
      });
  }
  await cli.parseAsync(process.argv);
}
