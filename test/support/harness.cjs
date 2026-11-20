const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { setTimeout: pause } = require("node:timers/promises");
const sdk = require(process.env.SUPERAGENT_TEST_PACKAGE || "../..");

async function until(read, description = "condition", timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) {
      return value;
    }
    await pause(15);
  }
  throw Error("Timed out waiting for " + description);
}

function tool(request, name, args) {
  const env = request.mcpConfig.mcpServers.assistant.env;
  return new Promise((resolve, reject) => {
    const rpc = http.request(
      {
        socketPath: env.AGENT_SOCKET,
        method: "POST",
        headers: { authorization: "Bearer " + env.AGENT_TURN_KEY },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.error) {
              throw Error(parsed.error);
            }
            resolve(JSON.parse(parsed.content[0].text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    rpc.on("error", reject);
    rpc.end(JSON.stringify({ method: "tools/call", params: { name, arguments: args } }));
  });
}

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync("/tmp/csa-spec-");
  const cwd = path.join(dir, "workspace");
  fs.mkdirSync(cwd);
  const route = sdk.localRoute("demo");
  const calls = [];
  const deliveries = [];
  let clock = Date.parse("2026-01-10T12:00:00Z");
  let respond =
    options.respond ||
    (async (request) => ({ text: "answered " + request.prompt, sessionId: "test-session" }));
  const settings = {
    dataDir: path.join(dir, "data"),
    workspaces: [{ id: "demo", cwd, timezone: "UTC", consolidateAt: "" }],
    tickMs: 15,
    now: () => clock,
    runner: async (request) => {
      calls.push(request);
      return respond(request);
    },
    deliver: async (item) => {
      deliveries.push(item);
      return options.deliver ? options.deliver(item) : "provider-" + item.id;
    },
  };
  const agent = sdk.createSuperAgent(settings);
  await agent.start();
  t.after(async () => {
    await agent.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    agent,
    dir,
    cwd,
    route,
    calls,
    deliveries,
    settings,
    now: () => clock,
    advance: (ms) => (clock += ms),
    setResponder: (fn) => (respond = fn),
    send: (text, id = randomUUID(), destination = route) =>
      agent.handleMessage({ ...destination, messageId: id, text }),
  };
}

function block(request) {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      return reject(request.signal.reason);
    }
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  });
}

module.exports = { sdk, fixture, until, tool, block };
