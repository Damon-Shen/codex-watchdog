import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const root = mkdtempSync(path.join(tmpdir(), "codex-watchdog-installed-cli-"));
try {
  const packResult = await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--json", "--pack-destination", root],
    { cwd: repositoryRoot },
  );
  assert.equal(packResult.code, 0, packResult.stderr);
  const packed = JSON.parse(packResult.stdout);
  const tarball = path.join(root, packed[0].filename);
  const installRoot = path.join(root, "install");
  const installResult = await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--prefix", installRoot, tarball, "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: root },
  );
  assert.equal(installResult.code, 0, installResult.stderr);

  const recordPath = path.join(root, "tui-invocation.json");
  const fakeCodexPath = path.join(root, "fake-codex.mjs");
  writeFileSync(fakeCodexPath, `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "app-server") {
  const listenIndex = args.indexOf("--listen");
  const address = new URL(args[listenIndex + 1]);
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/readyz" ? 200 : 404);
    response.end();
  });
  server.listen(Number(address.port), address.hostname);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ args, cwd: process.cwd() }));
}
`, "utf8");

  const targetDirectory = path.join(root, "target-project");
  mkdirSync(targetDirectory);
  const canonicalTargetDirectory = realpathSync(targetDirectory);
  const binName = process.platform === "win32" ? "codex-watchdog.cmd" : "codex-watchdog";
  const installedBin = path.join(installRoot, "node_modules", ".bin", binName);
  const cliResult = await run(installedBin, ["--version"], {
    cwd: targetDirectory,
    env: {
      ...process.env,
      CODEX_WATCHDOG_CODEX_JS: fakeCodexPath,
      FAKE_CODEX_RECORD: recordPath,
    },
  });
  assert.equal(cliResult.code, 0, cliResult.stderr);

  const invocation = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(invocation.cwd, canonicalTargetDirectory);
  assert.equal(invocation.args[0], "--remote");
  assert.match(invocation.args[1], /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(invocation.args.slice(2), ["-C", canonicalTargetDirectory, "--version"]);
  process.stdout.write("installed codex-watchdog command forwarded cwd and arguments correctly\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
