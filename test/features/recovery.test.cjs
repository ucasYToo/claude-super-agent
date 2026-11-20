const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { fixture, tool, until, block } = require("../support/harness.cjs");

test("progress checks have task-scoped tools; cancel suppresses a pending update", async (t) => {
  const f = await fixture(t);
  let finishProgress;
  f.setResponder(async (request) => {
    if (request.role === "worker") {
      return block(request);
    }
    if (request.prompt === "dispatch") {
      await tool(request, "dispatchJob", {
        key: "one",
        title: "progress test",
        prompt: "hold",
        eta: 3,
      });
    }
    if (request.prompt.includes('"state":"running"')) {
      await assert.rejects(
        tool(request, "dispatchJob", { key: "forbidden", title: "no", prompt: "no" }),
      );
      await assert.rejects(tool(request, "cancelJob", { id: 999 }));
      return new Promise((resolve) => {
        finishProgress = () => resolve({ text: "obsolete progress update" });
      });
    }
    return { text: "ack" };
  });
  await f.send("dispatch");
  await until(() => f.agent.listJobs(f.route.scope)[0]?.state === "running");
  f.advance(180001);
  await until(() => finishProgress);
  f.agent.cancelJob(f.route.scope, 1);
  finishProgress();
  await until(() => f.agent.status().activeTurns === 0);
  assert.equal(
    f.agent.history(f.route.scope).some((row) => row.text === "obsolete progress update"),
    false,
  );
});

test("nightly consolidation drains active turns, queues new messages and runs once for the local date", async (t) => {
  const f = await fixture(t);
  let release;
  f.agent.updateWorkspace("demo", { timezone: "UTC", consolidateAt: "12:01" });
  f.setResponder(async (r) => {
    if (r.role === "memory") {
      return new Promise((resolve) => {
        release = () => resolve({ text: JSON.stringify({ core: "a", notes: "b", journal: "c" }) });
      });
    }
    return { text: "ok", sessionId: "session-before-memory" };
  });
  await f.send("before");
  await until(() => f.agent.history(f.route.scope).some((row) => row.direction === "out"));
  f.advance(60000);
  await until(() => release);
  await f.send("during");
  assert.equal(
    f.calls.some((call) => call.prompt === "during"),
    false,
  );
  release();
  await until(() => f.calls.some((call) => call.prompt === "during"));
  const after = f.calls.find((call) => call.prompt === "during");
  assert.equal(after.sessionId, undefined);
  assert.match(after.system, /core\/profile.md/);
  f.advance(10000);
  assert.equal(f.calls.filter((call) => call.role === "memory").length, 1);
});

test("upgrade an existing v1 database and preserve job history", async (t) => {
  const f = await fixture(t);
  await f.send("saved", "old");
  await until(() => f.agent.history(f.route.scope).length >= 2);
  await f.agent.stop();
  const db = new DatabaseSync(path.join(f.dir, "data", "agent.sqlite"));
  db.exec(
    "DROP INDEX messages_turn; ALTER TABLE messages DROP COLUMN turn; PRAGMA user_version=1;",
  );
  db.close();
  await f.agent.start();
  assert.equal((await f.send("saved", "old")).duplicate, true);
  await f.send("new", "new");
  await until(() => f.agent.history(f.route.scope).some((m) => m.text === "answered new"));
});

test("workers stay inside configured directories and each image uses the selected vision model", async (t) => {
  const f = await fixture(t);
  const outside = fs.mkdtempSync("/tmp/csa-outside-");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const alias = path.join(f.cwd, "alias");
  fs.symlinkSync(outside, alias);
  assert.throws(
    () => f.agent.setWorker("demo", { name: "scout", purpose: "read", cwd: alias }),
    /未授权/,
  );
  f.agent.updateWorkspace("demo", { visionModel: "vision-test" });
  await f.agent.handleMessage({
    ...f.route,
    messageId: "image",
    text: "colors",
    image: {
      type: "image/png",
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgYERp7sAAAAASUVORK5CYII=",
        "base64",
      ),
    },
  });
  const request = await until(() => f.calls.find((call) => call.image));
  assert.equal(request.model, "vision-test");
  const input = f.agent.history(f.route.scope).find((row) => row.direction === "in");
  assert.equal(input.text, "[图片] colors");
});
