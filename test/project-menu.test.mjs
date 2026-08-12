import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWatchdogChildScript,
  normalizeCodexPath,
  parseSessionMetadataLine,
  selectRecentProjects,
} from "../src/project-menu.mjs";

test("parses only session metadata with a usable thread and working directory", () => {
  const line = JSON.stringify({
    type: "session_meta",
    payload: {
      id: "thread-1",
      cwd: "C:\\work\\project",
      source: "vscode",
    },
  });
  assert.deepEqual(
    parseSessionMetadataLine(line, { rolloutPath: "rollout.jsonl", updatedAtMs: 123 }),
    {
      threadId: "thread-1",
      cwd: "C:\\work\\project",
      source: "vscode",
      updatedAtMs: 123,
      rolloutPath: "rollout.jsonl",
    },
  );
  assert.equal(parseSessionMetadataLine("not json"), null);
  assert.equal(parseSessionMetadataLine(JSON.stringify({ type: "response_item" })), null);
});

test("selects the newest user session for each existing project", () => {
  const records = [
    { threadId: "old", cwd: "C:\\work\\one", source: "cli", updatedAtMs: 10 },
    { threadId: "new", cwd: "C:\\work\\one", source: "vscode", updatedAtMs: 30 },
    { threadId: "subagent", cwd: "C:\\work\\two", source: "subagent:thread_spawn", updatedAtMs: 40 },
    { threadId: "exec", cwd: "C:\\work\\three", source: "exec", updatedAtMs: 35 },
    { threadId: "other", cwd: "C:\\work\\two", source: "cli", updatedAtMs: 20 },
    { threadId: "missing", cwd: "C:\\missing", source: "cli", updatedAtMs: 50 },
  ];
  const existing = new Set(["C:\\work\\one", "C:\\work\\two"]);
  const projects = selectRecentProjects(records, {
    pathExists: (candidate) => existing.has(candidate),
  });

  assert.deepEqual(projects.map((project) => project.threadId), ["new", "other"]);
  assert.deepEqual(projects.map((project) => project.label), ["one", "two"]);
});

test("normalizes Windows extended-length Codex paths", () => {
  assert.equal(normalizeCodexPath("\\\\?\\D:\\work\\project"), "D:\\work\\project");
  assert.equal(
    normalizeCodexPath("\\\\?\\UNC\\server\\share\\project"),
    "\\\\server\\share\\project",
  );
});

test("builds a quoted resume command that always enables the recovery probe", () => {
  const script = buildWatchdogChildScript({
    cwd: "C:\\work\\owner's project",
    threadId: "thread-1",
    nodePath: "C:\\Program Files\\node.exe",
    launcherPath: "D:\\watchdog\\src\\launcher.mjs",
    label: "owner's project",
  });

  assert.match(script, /CODEX_WATCHDOG_PROBE_ENABLED = '1'/);
  assert.match(script, /'C:\\work\\owner''s project'/);
  assert.match(script, /'resume' 'thread-1'/);
});

test("builds a new-session command without a resume argument", () => {
  const script = buildWatchdogChildScript({
    cwd: "C:\\work\\project",
    mode: "new",
    nodePath: "node.exe",
    launcherPath: "launcher.mjs",
  });

  assert.doesNotMatch(script, /'resume'/);
  assert.match(script, /'-C' 'C:\\work\\project'/);
});
