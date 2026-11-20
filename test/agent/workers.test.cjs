const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture, until, tool, block } = require("../support/harness.cjs");

test("durable dispatch, concurrent redelivery, main session availability and result review", async (t) => {
  const f = await fixture(t);
  let finish;
  f.setResponder(async (request) => {
    if (request.role === "worker") {
      return new Promise((resolve) => {
        finish = () => resolve({ text: "JADE42", sessionId: "worker-session" });
      });
    }
    if (request.prompt === "dispatch") {
      const args = { key: "lookup", title: "Lookup", prompt: "Read README" };
      const first = await tool(request, "dispatchJob", args);
      assert.equal((await tool(request, "dispatchJob", args)).id, first.id);
    }
    return {
      text: request.prompt.includes('"succeeded"') ? "Verified JADE42" : "available",
      sessionId: "main-session",
    };
  });
  const receipts = await Promise.all(
    Array.from({ length: 20 }, () => f.send("dispatch", "same-id")),
  );
  assert.equal(receipts.filter((r) => !r.duplicate).length, 1);
  await until(() => finish);
  await f.send("second");
  await until(
    () =>
      f.agent.history(f.route.scope).filter((m) => m.direction === "out" && m.text === "available")
        .length === 2,
  );
  assert.equal(f.calls.find((c) => c.prompt === "second").sessionId, "main-session");
  finish();
  await until(() => f.agent.history(f.route.scope).some((m) => m.text.includes("Verified JADE42")));
  assert.equal(f.agent.listJobs(f.route.scope).length, 1);
  assert.equal(fs.readFileSync(path.join(f.cwd, ".superagent/jobs/1/result.md"), "utf8"), "JADE42");
  await f.agent.stop();
  await f.agent.start();
  assert.equal((await f.send("dispatch", "same-id")).duplicate, true);
});

test("capacity, cancellation, runtime timeout and interruption recover without replay", async (t) => {
  const f = await fixture(t);
  const errors = [];
  f.setResponder(async (request) => {
    if (request.role === "worker") {
      request.onSession("worker-" + request.prompt);
      return block(request);
    }
    if (request.prompt === "batch") {
      for (let i = 1; i <= 14; i++) {
        try {
          await tool(request, "dispatchJob", {
            key: String(i),
            title: "job" + i,
            prompt: String(i),
            eta: 3,
          });
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
    return { text: "ok" };
  });
  await f.send("batch");
  await until(() => errors.length === 1);
  const jobs = () => f.agent.listJobs(f.route.scope);
  assert.equal(jobs().filter((j) => j.state === "running").length, 3);
  assert.equal(jobs().filter((j) => j.state === "queued").length, 10);
  assert.match(errors[0], /队列已满/);
  assert.throws(() => f.agent.cancelJob({ ...f.route.scope, ownerId: "another" }, 1), /不存在/);
  f.agent.cancelJob(f.route.scope, 13);
  f.agent.cancelJob(f.route.scope, 1);
  await until(() => jobs().find((j) => j.id === 4).state === "running");
  f.advance(181 * 60000);
  await until(
    () =>
      jobs().some((j) => j.state === "timed_out") &&
      jobs().some((j) => j.state === "running" && j.id > 4),
  );
  await f.agent.stop();
  await f.agent.start();
  assert.ok(jobs().some((j) => j.state === "interrupted"));
  assert.equal(jobs().find((j) => j.id === 13).state, "cancelled");
  assert.equal(f.calls.filter((r) => r.role === "worker" && r.prompt === "1").length, 1);
});

test("resume a worker session and enforce the third handoff limit", async (t) => {
  const f = await fixture(t);
  const attempts = [];
  f.setResponder(async (request) => {
    if (request.role === "worker") {
      return { text: "done", sessionId: "worker-original" };
    }
    if (request.prompt === "start" || request.prompt === "continue") {
      await tool(request, "dispatchJob", {
        key: "one",
        title: "step",
        prompt: "read",
        ...(request.prompt === "continue" ? { continue: 1 } : {}),
      });
    } else if (request.prompt.includes('"succeeded"')) {
      try {
        await tool(request, "dispatchJob", { key: "next", title: "handoff", prompt: "read" });
      } catch {
        attempts.push("depth blocked");
      }
    }
    return { text: "reviewed" };
  });
  await f.send("start");
  await until(() => attempts.length === 1);
  assert.deepEqual(
    f.agent.listJobs(f.route.scope).map((j) => j.depth),
    [3, 2, 1],
  );
  await f.send("continue");
  await until(() => f.calls.some((r) => r.role === "worker" && r.sessionId === "worker-original"));
});
