// A separate process retains ownership of the Claude process group if the host dies.
const { spawn } = require("node:child_process");
let child;
let cancelling = false;
let forceTimer;

function terminate() {
  cancelling = true;
  if (!child?.pid) {
    return;
  }
  const kill = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  };
  kill("SIGTERM");
  forceTimer ??= setTimeout(() => kill("SIGKILL"), 1500);
}

process.on("disconnect", terminate);
process.on("SIGTERM", terminate);
process.on("message", (msg) => {
  if (msg.cancel) {
    return terminate();
  }
  if (child || cancelling) {
    return;
  }
  child = spawn(msg.command, msg.argv, {
    cwd: msg.cwd,
    env: msg.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.once("spawn", () => {
    if (process.connected) process.send({ pid: child.pid }, () => {});
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on("error", () => {});
  child.stdin.end(msg.input);
  child.on("error", (err) => {
    process.stderr.write(err.message);
  });
  child.on("close", (code) => {
    clearTimeout(forceTimer);
    if (cancelling && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    if (process.connected) {
      process.disconnect();
    }
    process.exitCode = code ?? 1;
  });
});
