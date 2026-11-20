import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import express from "express";

import { Workspace } from "../agent/contracts";
import { createSuperAgent } from "../agent/super-agent";
import { FeishuConnections } from "../channels/feishu/adapter";
import { initialize, openUrl } from "../cli/config";
import { standaloneAuth } from "../server/authentication";
import { createConsoleRouter } from "../server/console-router";
import { atomicWrite } from "../storage/files";

import { executableName } from "../runtime/claude/options";
import { claudeRunner } from "../runtime/claude/runner";

interface StartOptions {
  host: string;
  port: string | number;
  auth?: boolean;
  open?: boolean;
  verbose?: boolean;
}

export async function serve(dir: string, options: StartOptions) {
  let config = initialize(dir);
  const bots = new FeishuConnections();
  const agent = createSuperAgent({
    dataDir: dir,
    workspaces: config.workspaces,
    resolveWorkspace: (id) => config.workspaces.find((w) => w.id === id),
    runner: (input) => claudeRunner(config.claudeCommand)(input),
    deliver: (item) => bots.deliver(item),
  });
  if (options.verbose) {
    agent.onEvent((event) => console.log(new Date().toISOString(), event.kind));
  }
  await agent.start();
  const auth = standaloneAuth(dir, options.host, !!options.auth);
  const app = express();
  app.disable("x-powered-by");
  app.use(auth.router);
  const socketPath = path.join(dir, "control.sock");
  const runtime = path.join(dir, "runtime.json");
  let httpServer: http.Server | undefined;
  let control: http.Server | undefined;
  let closing = false;
  const stop = async () => {
    if (closing) {
      return;
    }
    closing = true;
    httpServer?.close();
    httpServer?.closeAllConnections();
    control?.close();
    control?.closeAllConnections();
    bots.close();
    await agent.stop();
    fs.rmSync(runtime, { force: true });
    fs.rmSync(socketPath, { force: true });
  };
  app.post("/internal/stop", (req, res) => {
    if (req.socket.remoteAddress) {
      res.sendStatus(403);
      return;
    }
    res.json({ ok: true });
    setImmediate(() => void stop());
  });
  app.get("/internal/status", (req, res) => {
    if (req.socket.remoteAddress) {
      res.sendStatus(403);
      return;
    }
    res.json({
      ...agent.status(),
      bots: bots.status(),
      ...JSON.parse(fs.readFileSync(runtime, "utf8")),
    });
  });
  app.use(
    createConsoleRouter({
      agent: () => agent,
      workspaces: () => config.workspaces.map((w) => w.id),
      authorize: auth.authorize,
      connections: () => bots.status(),
      testBot: (workspaceId, botId, openId) => bots.testMessage(workspaceId, botId, openId),
      settings: () => ({
        claudeCommand: config.claudeCommand || "claude",
        workspaces: config.workspaces.map((w) => ({ id: w.id, cwd: w.cwd })),
        bots: (config.feishu?.bots || []).map(({ appSecret, ...b }) => ({
          ...b,
          hasSecret: !!appSecret,
        })),
      }),
      saveSettings: (value) => {
        const workspaces: Workspace[] =
          value.workspaces?.map((input: Workspace) => ({
            ...config.workspaces.find((existing) => existing.id === input.id),
            ...input,
          })) ?? config.workspaces;
        if (
          !Array.isArray(workspaces) ||
          !workspaces.length ||
          new Set(workspaces.map((w) => w.id)).size !== workspaces.length
        ) {
          throw Error("工作区无效");
        }
        for (const w of workspaces) {
          if (
            !/^[a-zA-Z0-9_-]{1,80}$/.test(w.id) ||
            !path.isAbsolute(w.cwd) ||
            !fs.statSync(w.cwd).isDirectory()
          ) {
            throw Error("工作区路径无效");
          }
        }
        const updatedBots = (value.bots ?? config.feishu?.bots ?? []).map((b: any) => {
          const existing = config.feishu?.bots.find((o) => o.id === b.id && o.appId === b.appId);
          const { hasSecret, ...clean } = b;
          return {
            ...clean,
            appSecret: b.appSecret || existing?.appSecret,
            allowedOpenIds: b.allowedOpenIds ?? existing?.allowedOpenIds ?? [],
          };
        });
        const old = config;
        const claudeCommand =
          value.claudeCommand === undefined
            ? config.claudeCommand
            : executableName(value.claudeCommand);
        config = { ...config, claudeCommand, workspaces, feishu: { bots: updatedBots } };
        try {
          for (const workspace of workspaces) {
            agent.workspace(workspace.id);
          }
          if (value.bots !== undefined) bots.configure(updatedBots, agent);
          atomicWrite(path.join(dir, "config.json"), JSON.stringify(config, null, 2));
        } catch (e) {
          config = old;
          if (value.bots !== undefined) bots.configure(old.feishu?.bots || [], agent);
          throw e;
        }
      },
    }),
  );
  try {
    bots.configure(config.feishu?.bots || [], agent);
    fs.rmSync(socketPath, { force: true });
    control = app.listen(socketPath);
    await once(control, "listening");
    fs.chmodSync(socketPath, 0o600);
    httpServer = app.listen(Number(options.port), options.host);
    await once(httpServer, "listening");
    const address = httpServer.address() as { port: number };
    const url =
      "http://" + (options.host === "::1" ? "[::1]" : options.host) + ":" + address.port + "/";
    atomicWrite(
      runtime,
      JSON.stringify({ pid: process.pid, url, port: address.port, host: options.host }),
    );
    process.once("SIGTERM", () => void stop());
    process.once("SIGINT", () => void stop());
    if (process.send) {
      process.send({ url });
      process.disconnect();
    } else {
      console.log(url);
    }
    if (options.open) {
      openUrl(url);
    }
  } catch (e) {
    await stop();
    throw e;
  }
}
