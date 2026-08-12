import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopThreadPolicy, parseThreadPolicy } from "../src/desktop-thread-policy.mjs";

test("normalizes thread policy values and ignores unsupported modes", () => {
  assert.deepEqual(parseThreadPolicy(JSON.stringify({
    default: "monitor",
    threads: { one: "bypass", two: "monitor", three: "invalid" },
  })), {
    default: "monitor",
    threads: { one: "bypass", two: "monitor" },
  });
});

test("uses explicit per-thread modes before the default and reloads file changes", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "desktop-thread-policy-"));
  const filePath = path.join(directory, "policy.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(filePath, JSON.stringify({
    default: "bypass",
    threads: { monitored: "monitor" },
  }));
  const policy = new DesktopThreadPolicy({ filePath, logger: { warn() {} } });

  assert.equal(policy.shouldMonitor("monitored"), true);
  assert.equal(policy.shouldMonitor("ordinary"), false);
  assert.equal(policy.snapshot().monitoredCount, 1);

  writeFileSync(filePath, JSON.stringify({
    default: "monitor",
    threads: { ordinary: "bypass" },
  }));
  const futureMtime = new Date(Date.now() + 1_000);
  utimesSync(filePath, futureMtime, futureMtime);

  assert.equal(policy.shouldMonitor("monitored"), true);
  assert.equal(policy.shouldMonitor("ordinary"), false);
  assert.equal(policy.snapshot().bypassedCount, 1);
});

test("fails open when the policy file does not exist", () => {
  const policy = new DesktopThreadPolicy({
    filePath: path.join(os.tmpdir(), `missing-policy-${Date.now()}.json`),
    logger: { warn() {} },
  });
  assert.equal(policy.shouldMonitor("thread"), false);
  assert.equal(policy.snapshot().default, "bypass");
});
