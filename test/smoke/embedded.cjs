const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { once } = require("node:events");
const { until } = require("../support/harness.cjs");

async function main() {
  const host = path.resolve(process.argv[2] || "../llm-proxy");
  const fromHost = createRequire(path.join(host, "package.json"));
  const tmp = fs.mkdtempSync("/tmp/csa-embedded-");
  process.env.CLAUDE_PROXY_SUPERAGENT_DIR = path.join(tmp, "state");
  const workspace = path.join(tmp, "work");
  fs.mkdirSync(workspace);
  const bots = ["assistant", "bridge"].map((id, index) => ({
    id,
    appId: "app-" + id,
    appSecret: "test-only",
    defaultCwd: workspace,
    allowedUserIds: index ? ["owner"] : [],
    handler: index ? "bridge" : "superagent",
  }));
  const config = {
    remoteBridge: {
      enabled: true,
      claudeCommand: path.join(__dirname, "../support/fake-claude.cjs"),
      allowedCwds: [workspace],
      feishu: { enabled: true, bots },
    },
  };
  // Substitute machine-local configuration, old bridge history, and the network boundary.
  // The host route selection, assistant engine, child processes, web router and SQLite are real.
  fromHost("./dist/config/store").readConfig = () => config;
  fromHost("./dist/storage/db").getDb = () => ({
    prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
  });
  const sdkPath = fromHost.resolve("@larksuiteoapi/node-sdk");
  const realSdk = fromHost(sdkPath);
  const connections = new Map();
  const outbound = [];
  const reactions = [];
  let opens = 0;
  let closes = 0;
  class WS {
    constructor(options) {
      this.app = options.appId;
    }
    start({ eventDispatcher }) {
      assert.equal(connections.has(this.app), false);
      connections.set(this.app, eventDispatcher.handlers);
      opens++;
      return Promise.resolve();
    }
    close() {
      connections.delete(this.app);
      closes++;
    }
  }
  class Dispatcher {
    register(handlers) {
      this.handlers = handlers;
      return this;
    }
  }
  class Client {
    constructor(options) {
      const append = async (kind, input) => {
        outbound.push({ app: options.appId, kind, input });
        return { code: 0, data: { message_id: "provider-" + outbound.length } };
      };
      this.im = {
        messageReaction: {
          create: async ({ path, data }) => {
            reactions.push([options.appId, "add", path.message_id, data.reaction_type.emoji_type]);
            return { code: 0, data: { reaction_id: "working-" + path.message_id } };
          },
          delete: async ({ path }) => {
            reactions.push([options.appId, "remove", path.message_id, path.reaction_id]);
            return { code: 0 };
          },
        },
        message: { create: (input) => append("create", input) },
        v1: { message: { patch: (input) => append("patch", input) } },
      };
    }
  }
  require.cache[sdkPath].exports = {
    ...realSdk,
    WSClient: WS,
    EventDispatcher: Dispatcher,
    Client,
  };
  const bridge = fromHost("./dist/remote/feishu");
  const integration = fromHost("./dist/remote/superagent");
  const express = fromHost("express");
  const app = express();
  integration.mountSuperAgent(app, (_req, _res, next) => next());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port + "/superagent/";
  const send = (appId, id, text) =>
    connections.get(appId)["im.message.receive_v1"]({
      sender: { sender_type: "user", sender_id: { open_id: "owner" } },
      message: {
        message_type: "text",
        message_id: id,
        chat_id: "test-chat",
        chat_type: "p2p",
        content: JSON.stringify({ text }),
      },
    });
  try {
    bridge.startFeishuRemoteBridge();
    await integration.getSuperAgent();
    await until(
      () => fs.existsSync(path.join(workspace, "memory/MEMORY.md")),
      "workspace initialization",
    );
    assert.ok(fs.existsSync(path.join(workspace, "CLAUDE.md")));
    assert.equal(opens, 2);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Super Agent/);
    const adminState = await (await fetch(base + "api/state")).json();
    assert.equal(adminState.connections.length, 1);
    assert.equal(adminState.connections[0].id, "assistant");
    const testMessage = () =>
      fetch(base + "api/feishu/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botId: "assistant", openId: "owner" }),
      });
    assert.equal((await testMessage()).status, 400);
    await send("app-assistant", "unbound", "/help");
    assert.equal(outbound.length, 1);
    assert.deepEqual(reactions, []);
    assert.match(JSON.parse(outbound[0].input.data.content).text, /open_id 是：\nowner\n/);
    assert.deepEqual(config.remoteBridge.feishu.bots[0].allowedUserIds, []);
    config.remoteBridge.feishu.bots[0].allowedUserIds = ["owner"];
    bridge.restartFeishuRemoteBridge();
    assert.equal((await testMessage()).status, 200);
    await send("app-assistant", "request-1", "delegate");
    await send("app-assistant", "request-1", "delegate");
    await until(() => fs.existsSync(path.join(workspace, "worker.pid")), "worker started");
    await send("app-assistant", "request-2", "still available");
    await until(
      () => outbound.some((m) => m.input.data.content.includes("received still available")),
      "independent turn",
    );
    fs.writeFileSync(path.join(workspace, "release-worker"), "");
    await until(
      () => outbound.some((m) => m.input.data.content.includes("reviewed JADE42")),
      "final review",
      8000,
    );
    assert.deepEqual(
      reactions.filter((event) => event[2] === "request-1"),
      [
        ["app-assistant", "add", "request-1", "Typing"],
        ["app-assistant", "remove", "request-1", "working-request-1"],
      ],
    );
    const state = await (await fetch(base + "api/state")).json();
    const feishu = state.routes.find((r) => r.label.includes("test-chat"));
    const jobs = await (await fetch(base + "api/jobs?route=" + feishu.id)).json();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, "succeeded");
    assert.equal(
      outbound.filter((m) => m.input.data.content.includes("reviewed JADE42")).length,
      1,
    );
    await send("app-bridge", "request-3", "/help");
    assert.ok(outbound.some((m) => m.app === "app-bridge"));
    bridge.restartFeishuRemoteBridge();
    assert.equal(opens, 6);
    assert.equal(closes, 4);
    assert.equal(connections.size, 2);
    console.log(
      "Embedded smoke passed: installed package, real host routing, both bots, background dispatch, duplicate ingress, conversation continuity, web console and WS reload.",
    );
  } finally {
    bridge.stopFeishuRemoteBridge();
    await integration.stopSuperAgent();
    server.close();
    server.closeAllConnections();
    require.cache[sdkPath].exports = realSdk;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
