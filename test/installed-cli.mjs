import assert from "node:assert/strict";
import {
  existsSync,
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
  if (process.env.FAKE_APP_SERVER_RECORD) {
    writeFileSync(process.env.FAKE_APP_SERVER_RECORD, JSON.stringify({ args }));
  }
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

  const configRoot = path.join(root, "config-home");
  const pluginDirectory = path.join(configRoot, "codex-watchdog", "plugins");
  const pluginLifecyclePath = path.join(root, "plugin-lifecycle.txt");
  const pluginRecordPath = path.join(root, "plugin-tui-invocation.json");
  mkdirSync(pluginDirectory, { recursive: true });
  writeFileSync(path.join(pluginDirectory, "relay.mjs"), `
import { appendFileSync } from "node:fs";
export default ({ config }) => {
  appendFileSync(process.env.PLUGIN_LIFECYCLE_RECORD, \`init:\${config.model}\\n\`);
  return {
    apiVersion: 1,
    checkModel: async () => true,
    checkBalances: async () => [{ accountId: "primary", balance: 10 }],
    close() {
      appendFileSync(process.env.PLUGIN_LIFECYCLE_RECORD, "close\\n");
    },
  };
};
`, "utf8");
  writeFileSync(path.join(pluginDirectory, "relay.json"), JSON.stringify({
    apiVersion: 1,
    module: "./relay.mjs",
    stack: "custom",
    baseUrl: "https://relay.example",
    apiKeys: [{ id: "primary", value: "secret" }],
    model: "gpt-test",
    probeIntervalMs: 10,
    requestTimeoutMs: 10,
    balancePolicy: { mode: "any", minimum: 1 },
  }));
  const platformConfigEnv = process.platform === "win32"
    ? { APPDATA: configRoot }
    : { XDG_CONFIG_HOME: configRoot };
  const pluginCliResult = await run(installedBin, ["--plugin", "relay", "--version"], {
    cwd: targetDirectory,
    env: {
      ...process.env,
      ...platformConfigEnv,
      CODEX_WATCHDOG_CODEX_JS: fakeCodexPath,
      FAKE_CODEX_RECORD: pluginRecordPath,
      PLUGIN_LIFECYCLE_RECORD: pluginLifecyclePath,
    },
  });
  assert.equal(pluginCliResult.code, 0, pluginCliResult.stderr);
  const pluginInvocation = JSON.parse(readFileSync(pluginRecordPath, "utf8"));
  assert.deepEqual(
    pluginInvocation.args.slice(2),
    ["-C", canonicalTargetDirectory, "--version"],
  );
  assert.equal(readFileSync(pluginLifecyclePath, "utf8"), "init:gpt-test\nclose\n");

  const missingRecordPath = path.join(root, "missing-plugin-invocation.json");
  const missingAppServerRecordPath = path.join(root, "missing-plugin-app-server.json");
  const missingPluginResult = await run(installedBin, ["--plugin", "missing", "--version"], {
    cwd: targetDirectory,
    env: {
      ...process.env,
      ...platformConfigEnv,
      CODEX_WATCHDOG_CODEX_JS: fakeCodexPath,
      FAKE_CODEX_RECORD: missingRecordPath,
      FAKE_APP_SERVER_RECORD: missingAppServerRecordPath,
    },
  });
  assert.equal(missingPluginResult.code, 1);
  assert.match(missingPluginResult.stderr, /missing.*config/i);
  assert.equal(existsSync(missingRecordPath), false);
  assert.equal(existsSync(missingAppServerRecordPath), false);
  process.stdout.write("installed codex-watchdog command forwarded cwd and arguments correctly\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
