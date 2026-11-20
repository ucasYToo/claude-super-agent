import { fork } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

import { RunInput, RunResult } from "../../agent/contracts";

import { parentRulePatterns } from "../../workspaces/project-rules";

import { claudeArguments } from "./options";

const runtimeEnvironment = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

export function claudeRunner(command = "claude") {
  return async (request: RunInput): Promise<RunResult> => {
    request.signal.throwIfAborted();
    const argv = [
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--tools",
      request.tools.join(","),
      "--disable-slash-commands",
      "--append-system-prompt",
      request.system,
    ];
    if (request.tools.length || request.mcpConfig) {
      argv.push(
        "--allowedTools",
        [...request.tools, ...(request.mcpConfig ? ["mcp__assistant__*"] : [])].join(","),
      );
    }
    if (request.mcpConfig) {
      argv.push("--mcp-config", JSON.stringify(request.mcpConfig));
    }
    if (request.model) {
      argv.push("--model", request.model);
    }
    if (request.sessionId) {
      argv.push("--resume", request.sessionId);
    }
    if (request.role === "summary" || request.role === "memory" || request.image) {
      argv.push("--no-session-persistence");
    }
    if (request.role === "summary" || request.role === "memory") {
      argv.push("--setting-sources", "user", "--settings", '{"disableAllHooks":true}');
    }
    if (request.claudeOptions) argv.push(...claudeArguments(request.claudeOptions));
    if (request.excludeParentRules && ["main", "worker"].includes(request.role)) {
      argv.push(
        "--settings",
        JSON.stringify({ claudeMdExcludes: parentRulePatterns(request.cwd) }),
      );
    }
    const content: object[] = [{ type: "text", text: request.prompt }];
    if (request.image) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: request.image.type,
          data: request.image.data.toString("base64"),
        },
      });
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          runtimeEnvironment.has(key) ||
          ["LC_", "ANTHROPIC_", "CLAUDE_CODE_USE_", "AWS_"].some((prefix) =>
            key.startsWith(prefix),
          ),
      ),
    );
    return new Promise((resolve, reject) => {
      const guard = fork(path.join(__dirname, "../../../bin/supervise.js"), [], {
        silent: true,
        execArgv: [],
        env,
      });
      guard.once("message", (message: { pid?: number }) => {
        if (message?.pid && Number.isInteger(message.pid)) request.onProcess?.(message.pid);
      });
      let result: RunResult | undefined;
      let failure = "";
      let sessionId: string | undefined;
      const cancel = () => {
        if (guard.connected) {
          guard.send({ cancel: true }, () => {});
        }
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      const lines = createInterface({ input: guard.stdout! });
      lines.on("line", (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.session_id && event.session_id !== sessionId) {
          sessionId = event.session_id;
          request.onSession?.(event.session_id);
        }
        if (event.type === "assistant") {
          for (const block of event.message?.content ?? []) {
            if (block.type === "tool_use") {
              request.onProgress?.("使用工具 " + String(block.name).slice(0, 80));
            }
          }
        }
        if (event.type === "result") {
          if (event.is_error || event.subtype !== "success") {
            failure = String(event.result || event.subtype || "模型执行失败").slice(0, 500);
          } else {
            result = { text: String(event.result ?? "").slice(0, 160000), sessionId };
          }
        }
      });
      let stderr = "";
      guard.stderr!.on("data", (b) => {
        stderr = (stderr + String(b)).slice(-1000);
      });
      guard.once("error", reject);
      guard.once("close", (code) => {
        request.signal.removeEventListener("abort", cancel);
        if (request.signal.aborted) {
          return reject(request.signal.reason);
        }
        if (code !== 0 || failure || !result) {
          const hint = /ENOENT/.test(stderr) ? "，请检查 Claude CLI 路径" : "";
          return reject(Error(failure || "Claude CLI 未成功返回结果 (" + code + ")" + hint));
        }
        resolve(result);
      });
      guard.send({
        command,
        argv,
        cwd: request.cwd,
        env,
        input: JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
      });
      if (request.signal.aborted) {
        cancel();
      }
    });
  };
}
