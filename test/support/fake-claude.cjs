#!/usr/bin/env node
// Exercises the same stream protocol and external MCP process as the installed Claude CLI.
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { setTimeout: pause } = require("node:timers/promises");

function argument(flag) {
  return process.argv[process.argv.indexOf(flag) + 1];
}

async function dispatch() {
  const config = JSON.parse(argument("--mcp-config")).mcpServers.assistant;
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const responses = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "dispatchJob",
        arguments: { key: "demo", title: "Verify README", prompt: "worker-verification" },
      },
    }) + "\n",
  );
  const reply = JSON.parse((await responses.next()).value);
  child.stdin.end();
  if (reply.error) {
    throw Error(reply.error.message);
  }
  return "Task " + JSON.parse(reply.result.content[0].text).id + " accepted";
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const content = JSON.parse(input).message.content;
  const prompt = content[0].text;
  let result = "received " + prompt;
  const image = content.find((block) => block.type === "image");
  if (image) {
    const digest = require("node:crypto")
      .createHash("sha256")
      .update(Buffer.from(image.source.data, "base64"))
      .digest("hex");
    result = image.source.media_type + " " + digest;
  }
  if (prompt === "delegate") {
    result = await dispatch();
  }
  if (prompt === "worker-verification") {
    fs.writeFileSync("worker.pid", String(process.pid));
    while (!fs.existsSync("release-worker")) {
      await pause(20);
    }
    result = "verified JADE42";
  }
  if (prompt.includes('"succeeded"')) {
    result = "reviewed JADE42";
  }
  if (argument("--append-system-prompt").includes("记忆编辑")) {
    result = JSON.stringify({ core: "hello", notes: "notes", journal: "day" });
  }
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      result,
      session_id: "00000000-0000-4000-8000-000000000001",
    }) + "\n",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
