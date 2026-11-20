const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { until } = require("./harness.cjs");

async function startCli(t, extra = [], environment = {}) {
  const dir = fs.mkdtempSync("/tmp/csa-cli-");
  const workspace = path.join(dir, "workspace");
  const dataDir = path.join(dir, "state");
  const installed = process.env.SUPERAGENT_TEST_PACKAGE || path.join(__dirname, "../..");
  const binary = path.join(installed, "bin", "cli.js");
  const execWithInput = (input, ...args) =>
    execFileSync(process.execPath, [binary, "--data-dir", dataDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...environment },
      input,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const exec = (...args) => execWithInput(undefined, ...args);
  exec("init", "--workspace", workspace);
  const configPath = path.join(dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath));
  config.claudeCommand = path.join(__dirname, "fake-claude.cjs");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const base = exec("start", "--port", "0", ...extra);
  const status = () => JSON.parse(exec("status", "--json"));
  t.after(async () => {
    if (fs.existsSync(path.join(dataDir, "runtime.json"))) {
      exec("stop");
      await until(() => !fs.existsSync(path.join(dataDir, "runtime.json")), "CLI shutdown");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base, exec, execWithInput, status, workspace, dataDir };
}

module.exports = { startCli };
