const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

function verify(tarball, host) {
  const repo = path.resolve(__dirname, "../..");
  const sandbox = fs.mkdtempSync("/tmp/csa-package-");
  const archive = path.resolve(tarball);
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const manifest = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  if (
    manifest.some(
      (entry) =>
        !/^package\/(?:dist\/|web\/|bin\/|docs\/|templates\/workspace\/|package\.json$|README\.md$|LICENSE$)/.test(
          entry,
        ),
    )
  ) {
    throw Error("Unexpected public package content");
  }
  try {
    fs.writeFileSync(
      path.join(sandbox, "package.json"),
      JSON.stringify({ name: "package-smoke", version: "1.0.0", private: true }),
    );
    execFileSync("npm", ["install", archive, "--no-audit", "--no-fund"], {
      cwd: sandbox,
      stdio: "inherit",
    });
    const installed = path.join(sandbox, "node_modules", "claude-super-agent");
    const env = { ...process.env, SUPERAGENT_TEST_PACKAGE: installed };
    const fixtures = fs
      .readdirSync(path.join(repo, "test"), { recursive: true })
      .filter((file) => file.endsWith(".test.cjs"))
      .map((file) => path.join(repo, "test", file));
    execFileSync(process.execPath, ["--test", ...fixtures], {
      cwd: sandbox,
      env,
      stdio: "inherit",
    });
    const tsc = path.join(repo, "node_modules", "typescript", "bin", "tsc");
    fs.writeFileSync(
      path.join(sandbox, "consumer.ts"),
      'import {createSuperAgent, localRoute} from "claude-super-agent";\nconst agent = createSuperAgent({dataDir:"/tmp/example"});\nagent.listJobs(localRoute("project").scope);\n',
    );
    execFileSync(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--strict",
        "--module",
        "Node16",
        "--target",
        "ES2022",
        "--skipLibCheck",
        "consumer.ts",
      ],
      { cwd: sandbox, stdio: "inherit" },
    );
    execFileSync(process.execPath, [path.join(__dirname, "browser.cjs")], {
      env,
      cwd: sandbox,
      stdio: "inherit",
    });
    if (host) {
      const hostDir = path.resolve(host);
      const hostPackage = path.dirname(require.resolve("claude-super-agent", { paths: [hostDir] }));
      for (const entry of manifest.filter((p) => !p.endsWith("/"))) {
        const relative = entry.slice("package/".length);
        const standaloneBytes = fs.readFileSync(path.join(installed, relative));
        const hostBytes = fs.readFileSync(path.join(hostPackage, "..", relative));
        if (!standaloneBytes.equals(hostBytes)) {
          throw Error("Host package differs: " + relative);
        }
      }
      execFileSync(process.execPath, [path.join(__dirname, "embedded.cjs"), hostDir], {
        env,
        cwd: repo,
        stdio: "inherit",
      });
    }
    console.log("Verified tarball SHA-256 " + digest);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (!process.argv[2]) {
  throw Error("Usage: node test/smoke/package.cjs <tarball> [built-host-directory]");
}
verify(process.argv[2], process.argv[3]);
