import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopRetryRules, normalizeRetryRules } from "../src/desktop-retry-rules.mjs";

test("normalizes retry rules and ignores empty custom text rules", () => {
  assert.deepEqual(normalizeRetryRules({ rules: [
    { id: "one", label: "One", kind: "text", value: "temporary", enabled: true },
    { id: "empty", kind: "text", value: "" },
  ] }).rules.map(({ id }) => id), ["one"]);
});

test("reloads enabled built-in and custom retry rules", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "desktop-retry-rules-"));
  const filePath = path.join(directory, "rules.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(filePath, JSON.stringify({ rules: [
    { id: "503", kind: "status", value: "503", enabled: false, builtin: true },
    { id: "custom", kind: "text", value: "provider resting", enabled: true },
    { id: "stream", kind: "incomplete", value: "", enabled: false, builtin: true },
  ] }));
  const rules = new DesktopRetryRules({ filePath, logger: { warn() {} } });
  assert.equal(rules.matchesStatus(503), false);
  assert.equal(rules.matchesText("Provider resting now"), true);
  assert.equal(rules.matchesIncomplete(), false);

  writeFileSync(filePath, JSON.stringify({ rules: [
    { id: "503", kind: "status", value: "503", enabled: true, builtin: true },
  ] }));
  const future = new Date(Date.now() + 1_000); utimesSync(filePath, future, future);
  assert.equal(rules.matchesStatus(503), true);
  assert.equal(rules.matchesText("Provider resting now"), false);
});
