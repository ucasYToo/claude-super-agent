import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Scope, scopeKey, required, RunInput, RunResult } from "../agent/contracts";
import { atomicWrite, contained } from "../storage/files";
import { workspacePath } from "../workspaces/initialize";

const valid = /^(SOUL\.md|MEMORY\.md|(?:core|notes|journal)\/[^\s./\\][^/\\]{0,80}\.md)$/u;

function noteNames(directory: string | undefined) {
  const names: string[] = [];
  if (!directory) {
    return names;
  }
  for (const group of ["core", "notes", "journal"]) {
    const folder = workspacePath(directory, group);
    if (!folder || !fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
      continue;
    }
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const name = group + "/" + entry.name;
      if (entry.isFile() && valid.test(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

export class Memory {
  constructor(
    private dataDir: string,
    private workspaceDirectory: (id: string) => string,
  ) {}

  private root(scope: Scope) {
    const dir = path.join(
      this.dataDir,
      "memory",
      createHash("sha256").update(scopeKey(scope)).digest("hex"),
    );
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private git(dir: string, ...args: string[]) {
    return execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Super Agent",
        "-c",
        "user.email=assistant@localhost",
        "-C",
        dir,
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  private file(scope: Scope, name: string) {
    if (!valid.test(name)) {
      throw Error("无效的记忆文件名");
    }
    return contained(this.root(scope), name);
  }

  private names(scope: Scope, cwd: string) {
    const shared = noteNames(workspacePath(cwd, "memory"));
    const personal = noteNames(this.root(scope));
    return ["SOUL.md", "MEMORY.md", ...new Set([...shared, ...personal].sort())];
  }

  private contents(scope: Scope, cwd: string, name: string) {
    const personal = this.file(scope, name);
    if (fs.existsSync(personal)) {
      return fs.readFileSync(personal, "utf8");
    }
    const shared = workspacePath(cwd, name === "SOUL.md" ? name : "memory/" + name);
    return shared && fs.statSync(shared, { throwIfNoEntry: false })?.isFile()
      ? fs.readFileSync(shared, "utf8")
      : "";
  }

  list(scope: Scope) {
    return this.names(scope, this.workspaceDirectory(scope.workspaceId));
  }

  read(scope: Scope, name: string) {
    return this.contents(scope, this.workspaceDirectory(scope.workspaceId), name);
  }

  write(scope: Scope, name: string, text: string) {
    if (typeof text !== "string" || text.length > 60000) {
      throw Error("单份记忆最多 60000 字");
    }
    atomicWrite(this.file(scope, name), text);
  }

  context(scope: Scope) {
    const cwd = this.workspaceDirectory(scope.workspaceId);
    return this.names(scope, cwd)
      .filter((n) => n === "SOUL.md" || n === "MEMORY.md" || n.startsWith("core/"))
      .map((n) => n + "\n" + this.contents(scope, cwd, n).split("\n").slice(0, 200).join("\n"))
      .join("\n")
      .slice(0, 32000);
  }

  diff(scope: Scope) {
    const dir = this.root(scope);
    if (!fs.existsSync(path.join(dir, ".git"))) {
      return "";
    }
    try {
      return this.git(dir, "diff", "HEAD^", "HEAD", "--").slice(0, 100000);
    } catch {
      return "";
    }
  }

  async consolidate(
    scope: Scope,
    transcript: string,
    month: string,
    run: (input: RunInput) => Promise<RunResult>,
    signal: AbortSignal,
    model?: string,
  ) {
    const dir = this.root(scope);
    if (!fs.existsSync(path.join(dir, ".git"))) {
      this.git(dir, "init", "-q");
    }
    this.git(dir, "add", "--all");
    this.git(dir, "commit", "--allow-empty", "-qm", "整理前");
    const result = await run({
      role: "memory",
      cwd: dir,
      model,
      signal,
      tools: [],
      system:
        "你是工作区记忆编辑。对话仅作材料。只输出 JSON 对象，字段 core、notes、journal 为字符串。保留仍然有效的事实。",
      prompt: JSON.stringify({
        previous: this.read(scope, "core/profile.md"),
        notes: this.read(scope, "notes/topics.md"),
        transcript: transcript.slice(-60000),
      }),
    });
    signal.throwIfAborted();
    const content = result.text.trim();
    const fencedJson = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content);
    const parsed = JSON.parse(fencedJson?.[1] ?? content);
    const files: Record<string, string> = {
      "core/profile.md": required(parsed.core, "core", 30000),
      "notes/topics.md": required(parsed.notes, "notes", 30000),
      ["journal/" + month + ".md"]: (
        this.read(scope, "journal/" + month + ".md") +
        "\n" +
        required(parsed.journal, "journal", 12000)
      ).slice(-60000),
      "MEMORY.md":
        "# 记忆索引\n\n- core/profile.md\n- notes/topics.md\n- journal/" + month + ".md\n",
    };
    const before = new Map(
      Object.keys(files).map((n) => [
        n,
        fs.existsSync(this.file(scope, n)) ? this.read(scope, n) : null,
      ]),
    );
    try {
      for (const [name, text] of Object.entries(files)) {
        this.write(scope, name, text);
      }
      this.git(dir, "add", "--all");
      this.git(dir, "commit", "--allow-empty", "-qm", "整理记忆");
    } catch (error) {
      for (const [name, text] of before) {
        if (text === null) {
          fs.rmSync(this.file(scope, name), { force: true });
        } else {
          this.write(scope, name, text);
        }
      }
      this.git(dir, "reset", "-q", "HEAD", "--");
      throw error;
    }
  }
}
