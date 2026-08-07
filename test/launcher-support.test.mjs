import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  allocateDistinctTcpPorts,
  allocateTcpPort,
  ensureWorkingDirectoryArg,
  parseNonNegativeMilliseconds,
  resolveCodexEntrypoint,
  validateForwardedArgs,
  waitForHttpReady,
} from "../src/launcher-support.mjs";

test("resolves an explicit Codex entrypoint before npm", () => {
  const result = resolveCodexEntrypoint({
    env: { CODEX_WATCHDOG_CODEX_JS: "C:\\custom\\codex.js" },
    exists: (candidate) => candidate === "C:\\custom\\codex.js",
    resolveGlobalNpmRoot: () => { throw new Error("should not run"); },
  });
  assert.equal(result, "C:\\custom\\codex.js");
});

test("fails when an explicit Codex entrypoint does not exist", () => {
  assert.throws(
    () => resolveCodexEntrypoint({
      env: { CODEX_WATCHDOG_CODEX_JS: "C:\\missing\\codex.js" },
      exists: () => false,
    }),
    /does not exist/,
  );
});

test("resolves Codex from the global npm root", () => {
  const npmRoot = path.join("C:", "npm", "node_modules");
  const expected = path.join(npmRoot, "@openai", "codex", "bin", "codex.js");
  const result = resolveCodexEntrypoint({
    env: {},
    exists: (candidate) => candidate === expected,
    resolveGlobalNpmRoot: () => npmRoot,
  });
  assert.equal(result, expected);
});

test("uses the Windows npm fallback when npm root is unavailable", () => {
  const appData = "C:\\Users\\test\\AppData\\Roaming";
  const expected = path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  const result = resolveCodexEntrypoint({
    env: { APPDATA: appData },
    exists: (candidate) => candidate === expected,
    resolveGlobalNpmRoot: () => { throw new Error("npm unavailable"); },
  });
  assert.equal(result, expected);
});

test("fails clearly when the Codex npm entrypoint is unavailable", () => {
  assert.throws(
    () => resolveCodexEntrypoint({
      env: {},
      exists: () => false,
      resolveGlobalNpmRoot: () => "/global/node_modules",
    }),
    /Codex npm entrypoint was not found/,
  );
});

test("allocates an available loopback TCP port", async () => {
  const port = await allocateTcpPort();
  assert.ok(Number.isInteger(port));
  assert.ok(port > 0 && port <= 65_535);
});

test("allocates distinct ports when the operating system reuses one", async () => {
  const candidates = [45_000, 45_000, 45_001];
  const ports = await allocateDistinctTcpPorts(2, async () => candidates.shift());
  assert.deepEqual(ports, [45_000, 45_001]);
});

test("rejects invalid distinct port counts", async () => {
  await assert.rejects(() => allocateDistinctTcpPorts(0), /positive integer/);
  await assert.rejects(() => allocateDistinctTcpPorts(1.5), /positive integer/);
});

test("fails after repeated duplicate port allocations", async () => {
  let attempts = 0;
  await assert.rejects(
    () => allocateDistinctTcpPorts(2, async () => {
      attempts += 1;
      return 45_000;
    }),
    /Could not allocate 2 distinct TCP ports/,
  );
  assert.equal(attempts, 40);
});

test("waits until an HTTP readiness probe succeeds", async () => {
  let attempts = 0;
  await waitForHttpReady("http://127.0.0.1:1234/readyz", {
    timeoutMs: 500,
    intervalMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("not ready");
      return { ok: true };
    },
  });
  assert.equal(attempts, 3);
});

test("rejects a second remote endpoint that would bypass the watchdog", () => {
  assert.doesNotThrow(() => validateForwardedArgs(["--no-alt-screen", "-C", "C:\\work"]));
  assert.doesNotThrow(() => validateForwardedArgs(["--", "--remote"]));
  assert.throws(() => validateForwardedArgs(["--remote", "ws://elsewhere"]), /--remote/);
  assert.throws(() => validateForwardedArgs(["--remote=ws:\/\/elsewhere"]), /--remote/);
});

test("adds the current directory for remote TUI launches", () => {
  assert.deepEqual(
    ensureWorkingDirectoryArg(["resume"], "C:\\work\\repo"),
    ["-C", "C:\\work\\repo", "resume"],
  );
});

test("preserves an explicitly selected working directory", () => {
  for (const args of [
    ["resume", "-C", "C:\\other"],
    ["resume", "--cd", "C:\\other"],
    ["resume", "--cd=C:\\other"],
  ]) {
    assert.deepEqual(ensureWorkingDirectoryArg(args, "C:\\work\\repo"), args);
  }
});

test("does not treat prompt text after the option delimiter as a cwd flag", () => {
  assert.deepEqual(
    ensureWorkingDirectoryArg(["resume", "--", "-Code"], "C:\\work\\repo"),
    ["-C", "C:\\work\\repo", "resume", "--", "-Code"],
  );
});

test("parses an optional non-negative millisecond setting", () => {
  assert.equal(parseNonNegativeMilliseconds(undefined, 120_000, "SETTING"), 120_000);
  assert.equal(parseNonNegativeMilliseconds("5000", 120_000, "SETTING"), 5_000);
  assert.equal(parseNonNegativeMilliseconds("0", 120_000, "SETTING"), 0);
  assert.throws(
    () => parseNonNegativeMilliseconds("-1", 120_000, "SETTING"),
    /SETTING must be a non-negative number/,
  );
});
