import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import express, { Request, Response, NextFunction, RequestHandler } from "express";

import { localRoute, Route } from "../agent/contracts";
import { SuperAgent } from "../agent/super-agent";
import { imageInput } from "../channels/images";

import { readProjectRules } from "../workspaces/project-rules";
import { listDirectories, readJobEvents } from "./workspace-files";

export interface ConsoleOptions {
  agent: () => SuperAgent;
  workspaces: () => string[];
  authorize: RequestHandler;
  settings?: () => unknown;
  saveSettings?: (value: any) => void;
  connections?: () => unknown;
  testBot?: (workspaceId: string, botId: string, openId: string) => Promise<void>;
  hostSettingsUrl?: string;
}

const routeId = (route: Route) =>
  createHash("sha256").update(JSON.stringify(route)).digest("hex").slice(0, 24);

export function createConsoleRouter(options: ConsoleOptions) {
  const router = express.Router();
  router.use(express.json({ limit: "8mb" }));
  const hook = (req: Request, res: Response, next: NextFunction) => {
    try {
      const agent = options.agent();
      const body = req.body || {};
      const result = agent.webhooks.trigger(
        String(req.params.key),
        body.msg ?? req.query.msg,
        req.get("idempotency-key"),
        (id) => {
          try {
            agent.workspace(id);
            const selected = agent.status().selected;
            return !selected || selected === id;
          } catch {
            return false;
          }
        },
      );
      res.status(202).json(result);
    } catch (e) {
      next(e);
    }
  };
  router.get("/api/webhook/:key", hook);
  router.post("/api/webhook/:key", hook);
  router.use(options.authorize);
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; frame-ancestors 'self'; form-action 'self'; base-uri 'self'",
    );
    if (
      req.method !== "GET" &&
      (req.get("sec-fetch-site") === "cross-site" ||
        (req.headers.origin && new URL(req.headers.origin).host !== req.get("host")))
    ) {
      res.status(403).json({ error: "跨站写请求" });
      return;
    }
    next();
  });
  function context(req: Request) {
    const agent = options.agent();
    const ids = options.workspaces();
    const id = String(req.query.workspace || ids[0] || "");
    if (!ids.includes(id)) {
      throw Error("工作区不可用");
    }
    const workspace = agent.workspace(id);
    const routes = [
      localRoute(id),
      ...agent.routes(id).filter((route) => route.target.kind === "feishu"),
    ];
    const route = req.query.route
      ? routes.find((item) => routeId(item) === req.query.route)
      : routes[0];
    if (!route) {
      throw Error("会话目标已失效");
    }
    return { agent, workspace, route, routes, ids };
  }
  router.get("/api/state", (req, res) => {
    const { agent, workspace, route, routes, ids } = context(req);
    res.json({
      workspaces: ids,
      workspace: workspace,
      routes: routes.map((route) => ({
        id: routeId(route),
        label:
          route.target.kind === "local"
            ? "本地会话"
            : route.target.botId + " · " + route.target.chatId,
      })),
      route: routeId(route),
      status: agent.status(),
      sessionStatus: agent.sessionStatus(route),
      session: agent.sessionDetails(route),
      consolidation: agent.memoryStatus(route.scope),
      hostSettingsUrl: options.hostSettingsUrl,
      canTestBot: !!options.testBot,
      jobs: agent.listJobs(route.scope),
      tasks: agent.schedules.schedules(route.scope),
      hooks: agent.webhooks.hooks(route.scope),
      memory: agent.memory.list(route.scope),
      connections: options.connections?.(),
      settings: options.settings?.(),
    });
  });
  if (options.saveSettings) {
    router.get("/api/directories", (req, res) => {
      const { workspace } = context(req);
      res.json(listDirectories(String(req.query.cwd || workspace.cwd)));
    });
  }
  router.get("/api/jobs/:id/events", (req, res) => {
    const { agent, route, workspace } = context(req);
    const id = Number(req.params.id);
    if (!agent.listJobs(route.scope).some((job) => job.id === id)) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json(readJobEvents(workspace.cwd, id));
  });
  router.get("/api/jobs", (req, res) => {
    const { agent, route } = context(req);
    res.json(agent.listJobs(route.scope));
  });
  router.post("/api/jobs/:id/cancel", (req, res) => {
    const { agent, route } = context(req);
    res.json(agent.cancelJob(route.scope, Number(req.params.id)));
  });
  router.get("/api/history", (req, res) => {
    const { agent, route } = context(req);
    res.json(
      agent.history(
        route.scope,
        String(req.query.q || ""),
        String(req.query.source || ""),
        String(req.query.status || ""),
        Number(req.query.from) || 0,
        Number(req.query.to) || Number.MAX_SAFE_INTEGER,
        req.query.conversation === "current" ? route.conversationKey : "",
      ),
    );
  });
  router.get("/api/memory", (req, res) => {
    const { agent, route, workspace } = context(req);
    const name = String(req.query.name || "SOUL.md");
    res.json({
      text:
        name === "CLAUDE.md"
          ? readProjectRules(workspace.cwd)
          : agent.memory.read(route.scope, name),
    });
  });
  router.get("/api/memory/diff", (req, res) => {
    const { agent, route } = context(req);
    res.json({ text: agent.memory.diff(route.scope) });
  });
  router.get("/api/events", (req, res) => {
    const { agent } = context(req);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const unsub = agent.onEvent((e) => res.write("data: " + JSON.stringify(e) + "\n\n"));
    const timer = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    res.on("close", () => {
      clearInterval(timer);
      unsub();
    });
  });
  type ConsoleAction = (selection: ReturnType<typeof context>, request: Request) => unknown;
  function post(endpoint: string, execute: ConsoleAction) {
    router.post("/api/" + endpoint, async (request, response, next) => {
      try {
        const result = await execute(context(request), request);
        response.json(result ?? { ok: true });
      } catch (error) {
        next(error);
      }
    });
  }

  post("chat/send", ({ agent, route }, { body }) =>
    agent.handleMessage({
      ...route,
      target: { kind: "local", clientId: "console" },
      text: body.text,
      messageId: body.messageId || randomUUID(),
      image: body.image ? imageInput(Buffer.from(body.image, "base64")) : undefined,
    }),
  );
  post("workspace/save", ({ agent, workspace }, { body }) =>
    agent.updateWorkspace(workspace.id, body),
  );
  if (options.saveSettings) {
    post("workspace/select", ({ agent, workspace }, { body }) =>
      agent.selectWorkspace(body?.all === true ? null : workspace.id),
    );
  }
  post("workers/save", ({ agent, workspace }, { body }) => agent.setWorker(workspace.id, body));
  post("workers/remove", ({ agent, workspace }, { body }) =>
    agent.setWorker(workspace.id, body, true),
  );
  post("tasks/add", ({ agent, route, workspace }, { body }) => ({
    id: agent.schedules.addSchedule(route, { ...body, tz: body.tz || workspace.timezone }),
  }));
  post("tasks/edit", ({ agent, route }, { body }) =>
    agent.schedules.edit(route.scope, Number(body.id), body),
  );
  post("tasks/:action", ({ agent, route }, request) =>
    agent.schedules.scheduleAction(
      route.scope,
      Number(request.body.id),
      String(request.params.action),
    ),
  );
  post("hooks/add", ({ agent, route }, { body }) => agent.webhooks.addHook(route, body));
  post("hooks/:action", ({ agent, route }, request) =>
    agent.webhooks.hookAction(
      route.scope,
      Number(request.body.id),
      String(request.params.action),
      request.body,
    ),
  );
  post("memory/save", ({ agent, route }, { body }) =>
    agent.writeMemory(route.scope, body.name, body.text),
  );
  post("memory/consolidate", ({ agent, route }) => agent.consolidate(route.scope));
  if (options.testBot) {
    post("feishu/test", ({ workspace }, { body }) =>
      options.testBot!(workspace.id, String(body.botId), String(body.openId)),
    );
  }
  if (options.saveSettings) {
    post("settings/save", (_context, { body }) => options.saveSettings!(body));
  }
  router.use(express.static(path.join(__dirname, "../../web")));
  router.use(
    (err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status || 400).json({ error: err.message });
    },
  );
  return router;
}
