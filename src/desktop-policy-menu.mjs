import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { parseThreadPolicy } from "./desktop-thread-policy.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function latestStateDatabase(codexHome) {
  return readdirSync(codexHome)
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((left, right) => Number(right.match(/\d+/)[0]) - Number(left.match(/\d+/)[0]))
    .map((name) => path.join(codexHome, name))[0];
}

export function loadDesktopThreads({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  limit = 50,
} = {}) {
  const databasePath = latestStateDatabase(codexHome);
  if (!databasePath) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(
      "SELECT id, title, cwd, recency_at_ms FROM threads " +
      "WHERE archived = 0 AND thread_source = 'user' " +
      "ORDER BY recency_at_ms DESC LIMIT ?",
    ).all(limit);
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title || "Untitled conversation"),
      cwd: String(row.cwd || "").replace(/^\\\\\?\\/, ""),
      recencyAtMs: Number(row.recency_at_ms),
    }));
  } finally {
    database.close();
  }
}

export function readPolicyFile(filePath) {
  if (!existsSync(filePath)) return { default: "bypass", threads: {} };
  return parseThreadPolicy(readFileSync(filePath, "utf8"));
}

export function writePolicyFile(filePath, policy) {
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

function truncate(value, width) {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(1, width - 3))}...`;
}

function render({ threads, policy, cursor, scrollOffset }) {
  const width = Math.max(process.stdout.columns || 100, 70);
  const height = Math.max(process.stdout.rows || 30, 14);
  const visibleCount = Math.max(4, height - 8);
  const visible = threads.slice(scrollOffset, scrollOffset + visibleCount);
  const lines = [
    "Codex Desktop input.im gate policy",
    `Default for new chats: ${policy.default.toUpperCase()}`,
    "Checked chats pause while gpt-5.6-sol is unavailable.",
    "",
  ];
  visible.forEach((thread, offset) => {
    const index = scrollOffset + offset;
    const selected = (policy.threads[thread.id] ?? policy.default) === "monitor";
    const pointer = index === cursor ? ">" : " ";
    const project = path.basename(thread.cwd) || thread.cwd || "no project";
    const prefix = `${pointer} [${selected ? "x" : " "}] `;
    const suffix = ` | ${project} | ${thread.id.slice(0, 8)}`;
    lines.push(prefix + truncate(thread.title, width - prefix.length - suffix.length) + suffix);
  });
  lines.push("");
  lines.push("Up/Down move  Space toggle  D default  Enter save  Esc cancel");
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}`);
}

export async function runDesktopPolicyMenu({
  filePath = process.env.CODEX_DESKTOP_THREAD_POLICY_FILE || path.join(projectRoot, "desktop-watchdog.policy.json"),
  loadThreads = loadDesktopThreads,
} = {}) {
  const threads = loadThreads();
  const policy = readPolicyFile(filePath);
  if (threads.length === 0) {
    process.stdout.write("No Codex Desktop conversations found.\n");
    return false;
  }

  return new Promise((resolve) => {
    let cursor = 0;
    let scrollOffset = 0;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write("\x1b[?25l");

    const redraw = () => {
      const visibleCount = Math.max(4, Math.max(process.stdout.rows || 30, 14) - 8);
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + visibleCount) scrollOffset = cursor - visibleCount + 1;
      render({ threads, policy, cursor, scrollOffset });
    };
    const finish = (saved) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h\n");
      resolve(saved);
    };

    process.stdin.on("keypress", (_, key) => {
      if (key.name === "up") cursor = Math.max(0, cursor - 1);
      else if (key.name === "down") cursor = Math.min(threads.length - 1, cursor + 1);
      else if (key.name === "space") {
        const thread = threads[cursor];
        const current = policy.threads[thread.id] ?? policy.default;
        policy.threads[thread.id] = current === "monitor" ? "bypass" : "monitor";
      } else if (key.name === "d") {
        policy.default = policy.default === "monitor" ? "bypass" : "monitor";
      } else if (key.name === "return") {
        writePolicyFile(filePath, policy);
        finish(true);
        return;
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish(false);
        return;
      }
      redraw();
    });
    redraw();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopPolicyMenu()
    .then((saved) => { process.exitCode = saved ? 0 : 1; })
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}
