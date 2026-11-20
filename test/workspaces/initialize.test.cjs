const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fixture, sdk, until } = require("../support/harness.cjs");

const packageRoot = process.env.SUPERAGENT_TEST_PACKAGE || path.resolve(__dirname, "../..");

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "csa-workspace-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("CLI init creates usable starter files before startup and repairs only missing files", (t) => {
  const root = tempDir(t);
  const workspace = path.join(root, "project");
  const init = () =>
    execFileSync(process.execPath, [
      path.join(packageRoot, "bin/cli.js"),
      "--data-dir",
      path.join(root, "data"),
      "init",
      "--workspace",
      workspace,
    ]);

  init();
  for (const file of [
    "CLAUDE.md",
    "SOUL.md",
    "memory/MEMORY.md",
    "memory/core/profile.md",
    "memory/notes/topics.md",
    ".claude/skills/superagent-jobs/SKILL.md",
    ".superagent/jobs/WORKERS.md",
  ]) {
    assert.ok(fs.readFileSync(path.join(workspace, file), "utf8").trim(), file);
  }
  assert.deepEqual(fs.readdirSync(path.join(workspace, "memory/journal")), []);
  const rules = path.join(workspace, "CLAUDE.md");
  const profile = path.join(workspace, "memory/core/profile.md");
  fs.writeFileSync(rules, "团队约定");
  fs.writeFileSync(profile, "");
  const index = path.join(workspace, "memory/MEMORY.md");
  fs.unlinkSync(index);
  init();
  assert.equal(fs.readFileSync(rules, "utf8"), "团队约定");
  assert.equal(fs.readFileSync(profile, "utf8"), "");
  assert.match(fs.readFileSync(index, "utf8"), /core\/profile.md/);
});

test("SDK startup backfills a project with legacy private memory and existing links", async (t) => {
  const root = tempDir(t);
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const scope = { workspaceId: "demo", ownerId: "previous-user" };
  const dataDir = path.join(root, "state");
  const hash = createHash("sha256")
    .update(JSON.stringify(["demo", "previous-user"]))
    .digest("hex");
  const legacy = path.join(dataDir, "memory", hash);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "SOUL.md"), "旧版个人偏好");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, "memory"), "dir");
  fs.symlinkSync(path.join(outside, "rules"), path.join(cwd, "CLAUDE.md"));
  const agent = sdk.createSuperAgent({ dataDir, workspaces: [{ id: "demo", cwd }] });
  await agent.start();
  t.after(() => agent.stop());
  assert.ok(fs.existsSync(path.join(cwd, "SOUL.md")));
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(agent.memory.read(scope, "SOUL.md"), "旧版个人偏好");
  assert.equal(agent.memory.read(scope, "MEMORY.md"), "");
  assert.ok(fs.lstatSync(path.join(cwd, "CLAUDE.md")).isSymbolicLink());
});

test("turns use live workspace defaults and each user's own overrides", async (t) => {
  const f = await fixture(t);
  const owner = f.route.scope;
  const guest = { ...owner, ownerId: "guest" };
  const write = (file, value) => fs.writeFileSync(path.join(f.cwd, file), value);
  write("SOUL.md", "共同称呼");
  write("memory/core/project.md", "项目用语");
  write("memory/notes/topic.md", "按需读取的资料");
  await f.send("首次读取");
  const request = await until(() => f.calls.find((r) => r.prompt === "首次读取"));
  assert.match(request.system, /共同称呼/);
  assert.match(request.system, /项目用语/);
  assert.doesNotMatch(request.system, /按需读取的资料/);
  assert.ok(f.agent.memory.list(owner).includes("notes/topic.md"));
  assert.equal(f.agent.memory.read(owner, "notes/topic.md"), "按需读取的资料");
  f.agent.writeMemory(owner, "SOUL.md", "个人称呼");
  f.agent.writeMemory(owner, "notes/topic.md", "");
  write("SOUL.md", "新的共同称呼");
  assert.equal(f.agent.memory.read(owner, "SOUL.md"), "个人称呼");
  assert.equal(f.agent.memory.read(owner, "notes/topic.md"), "");
  assert.equal(f.agent.memory.read(guest, "SOUL.md"), "新的共同称呼");
  assert.equal(f.agent.memory.read(guest, "notes/topic.md"), "按需读取的资料");
});

test("worker and runtime configuration reach both disk and newly started turns", async (t) => {
  const f = await fixture(t);
  f.agent.setWorker("demo", { name: "scout", purpose: "检索", model: "sonnet" });
  const roster = path.join(f.cwd, ".superagent/jobs/WORKERS.md");
  assert.match(fs.readFileSync(roster, "utf8"), /scout · sonnet · 检索/);
  f.agent.setWorker("demo", { name: "scout", purpose: "检索" }, true);
  assert.doesNotMatch(fs.readFileSync(roster, "utf8"), /scout/);
  f.agent.updateWorkspace("demo", { claudeOptions: ["--effort high"], excludeParentRules: true });
  assert.throws(
    () => f.agent.updateWorkspace("demo", { claudeOptions: ["--settings injected"] }),
    /无效/,
  );
  await f.send("读取设置");
  const turn = await until(() => f.calls.find((r) => r.prompt === "读取设置"));
  assert.deepEqual(turn.claudeOptions, ["--effort high"]);
  assert.equal(turn.excludeParentRules, true);
});
