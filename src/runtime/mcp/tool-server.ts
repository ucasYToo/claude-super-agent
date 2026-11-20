import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

type Args = Record<string, unknown>;

const string = { type: "string" };
const integer = { type: "integer" };
const definitions = [
  ["readMemory", "按索引读取当前用户的主题笔记或人格", { name: string }, ["name"]],
  ["writeSoul", "按用户明确要求保存助手的人格与约定", { text: string }, ["text"]],
  [
    "dispatchJob",
    "派发完整独立任务，返回任务编号。相同操作重试使用相同 key。",
    { key: string, title: string, prompt: string, worker: string, eta: integer, continue: integer },
    ["key", "title", "prompt"],
  ],
  ["updateEta", "更新本任务的下次进度检查", { eta: integer }, ["eta"]],
  ["cancelJob", "取消任务", { id: integer }, ["id"]],
  [
    "proposeSchedule",
    "提议一次性或周期任务，等待用户批准",
    { title: string, prompt: string, cron: string, at: string },
    ["title", "prompt"],
  ],
  [
    "configureWorker",
    "配置工作区 Worker，remove 表示移除",
    {
      name: string,
      purpose: string,
      model: string,
      cwd: string,
      instructions: string,
      tools: { type: "array", items: string },
      remove: { type: "boolean" },
    },
    ["name"],
  ],
] as const;

interface Grant {
  names: string[];
  call: (name: string, args: Args) => unknown;
}

export class ToolServer {
  private grants = new Map<string, Grant>();
  private server?: http.Server;
  private dir = "";

  async start() {
    this.dir = fs.mkdtempSync("/tmp/claude-sa-");
    this.server = http.createServer(async (req, res) => {
      try {
        const grant = this.grants.get(String(req.headers.authorization).replace(/^Bearer /, ""));
        if (!grant) {
          throw Error("授权已失效");
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 65536) {
            throw Error("请求过长");
          }
        }
        const { method, params } = JSON.parse(body);
        if (method === "tools/list") {
          return void res.end(
            JSON.stringify({
              tools: definitions
                .filter(([name]) => grant.names.includes(name))
                .map(([name, description, properties, required]) => ({
                  name,
                  description,
                  inputSchema: {
                    type: "object",
                    properties,
                    required,
                    additionalProperties: false,
                  },
                })),
            }),
          );
        }
        if (method !== "tools/call" || !grant.names.includes(params.name)) {
          throw Error("该轮不可执行此操作");
        }
        const result = grant.call(params.name, params.arguments || {});
        res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
    this.server.listen(path.join(this.dir, "mcp.sock"));
    await once(this.server, "listening");
  }

  issue(grant: Grant) {
    const token = randomBytes(32).toString("hex");
    this.grants.set(token, grant);
    return {
      config: {
        mcpServers: {
          assistant: {
            command: process.execPath,
            args: [path.join(__dirname, "../../../bin/tools.js")],
            env: { AGENT_SOCKET: path.join(this.dir, "mcp.sock"), AGENT_TURN_KEY: token },
          },
        },
      },
      revoke: () => this.grants.delete(token),
    };
  }

  async stop() {
    this.grants.clear();
    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
    }
    if (this.dir) {
      fs.rmSync(this.dir, { recursive: true, force: true });
    }
  }
}
