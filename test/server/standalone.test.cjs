const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startCli } = require("../support/cli-process.cjs");
const { until } = require("../support/harness.cjs");
const options = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("installed CLI drives external MCP, a worker, interleaved chat and final review", async (t) => {
  const cli = await startCli(t);
  const send = (text) => fetch(cli.base + "api/chat/send", options({ text }));
  assert.equal((await fetch(cli.base)).status, 200);
  assert.equal((await send("delegate")).status, 200);
  await until(() => fs.existsSync(path.join(cli.workspace, "worker.pid")), "worker fork");
  await send("next message");
  await until(async () =>
    (await (await fetch(cli.base + "api/history")).json()).some(
      (row) => row.text === "received next message",
    ),
  );
  fs.writeFileSync(path.join(cli.workspace, "release-worker"), "");
  await until(async () =>
    (await (await fetch(cli.base + "api/history")).json()).some((row) =>
      row.text.includes("reviewed JADE42"),
    ),
  );
  assert.equal(JSON.parse(cli.exec("jobs", "list", "--json"))[0].state, "succeeded");
  assert.equal((await fetch(cli.base + "api/memory/consolidate", options({}))).status, 200);
  assert.match((await (await fetch(cli.base + "api/memory/diff")).json()).text, /notes/);
  assert.equal((await fetch(cli.base + "internal/stop", options({}))).status, 403);
  assert.equal(
    (
      await fetch(cli.base + "api/tasks/add", {
        ...options({}),
        headers: { Origin: "https://other.invalid", "content-type": "application/json" },
      })
    ).status,
    403,
  );
});

test("stream-json transports the original image bytes to the CLI", async (t) => {
  const cli = await startCli(t);
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgYERp7sAAAAASUVORK5CYII=",
    "base64",
  );
  const digest = require("node:crypto").createHash("sha256").update(image).digest("hex");
  const result = await fetch(
    cli.base + "api/chat/send",
    options({ text: "image", image: image.toString("base64") }),
  );
  assert.equal(result.status, 200);
  await until(async () =>
    (await (await fetch(cli.base + "api/history")).json()).some(
      (message) => message.text === "image/png " + digest,
    ),
  );
});

test("abrupt host exit terminates the owned worker and persisted jobs recover", async (t) => {
  const cli = await startCli(t);
  await fetch(cli.base + "api/chat/send", options({ text: "delegate" }));
  const pidFile = path.join(cli.workspace, "worker.pid");
  await until(() => fs.existsSync(pidFile));
  const worker = Number(fs.readFileSync(pidFile));
  process.kill(cli.status().pid, "SIGKILL");
  await until(
    () => {
      try {
        process.kill(worker, 0);
        return false;
      } catch {
        return true;
      }
    },
    "orphan termination",
    6000,
  );
  cli.exec("start", "--port", "0");
  assert.equal(JSON.parse(cli.exec("jobs", "list", "--json"))[0].state, "interrupted");
});

test("remote console requires credentials and webhook management is protected", async (t) => {
  const cli = await startCli(t, ["--host", "0.0.0.0"]);
  const base = cli.base.replace("0.0.0.0", "127.0.0.1");
  assert.equal((await fetch(base + "api/state")).status, 401);
  const auth = {
    ...options({ title: "CI", prompt: "Review" }),
    headers: { "content-type": "application/json", authorization: "Bearer " + cli.exec("token") },
  };
  const hook = await (await fetch(base + "api/hooks/add", auth)).json();
  assert.ok(hook.secret);
  const url = base + "api/webhook/" + hook.secret + "?msg=test";
  assert.equal((await fetch(url)).status, 202);
  assert.equal((await fetch(url)).status, 429);
});

test("account login, password rotation and failed-login throttling", async (t) => {
  const cli = await startCli(t, ["--auth"]);
  const login = (password) =>
    fetch(cli.base + "login", {
      method: "POST",
      body: new URLSearchParams({ name: "reader", password }),
      redirect: "manual",
    });
  const state = (cookie) => fetch(cli.base + "api/state", { headers: { cookie } });

  cli.execWithInput("first-password\n", "user", "add", "reader", "--password-stdin");
  assert.equal((await state("")).status, 401);
  const response = await login("first-password");
  assert.equal(response.status, 302);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await state(cookie)).status, 200);

  cli.execWithInput("second-password\n", "user", "passwd", "reader", "--password-stdin");
  assert.equal((await state(cookie)).status, 401);
  assert.equal((await login("second-password")).status, 302);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await login("incorrect")).status, 401);
  }
  assert.equal((await login("incorrect")).status, 429);
});

test("saving a second workspace initializes it before any chat or selection", async (t) => {
  const cli = await startCli(t);
  const second = path.join(path.dirname(cli.workspace), "second");
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, "CLAUDE.md"), "existing rules");
  const response = await fetch(
    cli.base + "api/settings/save",
    options({
      workspaces: [
        { id: "default", cwd: cli.workspace },
        { id: "second", cwd: second },
      ],
    }),
  );
  assert.equal(response.status, 200);
  assert.ok(fs.existsSync(path.join(second, "memory/core/profile.md")));
  assert.equal(fs.readFileSync(path.join(second, "CLAUDE.md"), "utf8"), "existing rules");
});

test("console reads project rules, validates CLI options, and checks scope before reading job logs", async (t) => {
  const cli = await startCli(t);
  const get = async (endpoint) => (await fetch(cli.base + "api/" + endpoint)).json();
  assert.match((await get("memory?name=CLAUDE.md")).text, /工作区/);
  assert.equal(
    (await fetch(cli.base + "api/memory/save", options({ name: "CLAUDE.md", text: "replace" })))
      .status,
    400,
  );
  assert.equal(
    (await fetch(cli.base + "api/feishu/test", options({ botId: "missing", openId: "missing" })))
      .status,
    400,
  );
  assert.equal(
    (
      await fetch(
        cli.base + "api/settings/save",
        options({ claudeCommand: "/path/that/does/not/exist" }),
      )
    ).status,
    400,
  );
  assert.equal((await fetch(cli.base + "api/jobs/123/events")).status, 404);
  await fetch(cli.base + "api/chat/send", options({ text: "delegate" }));
  await until(() => fs.existsSync(path.join(cli.workspace, "worker.pid")));
  assert.ok((await get("jobs/1/events")).some((e) => e.event === "开始执行"));
  fs.writeFileSync(path.join(cli.workspace, "release-worker"), "");
});
