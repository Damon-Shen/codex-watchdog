import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const MAX_METADATA_BYTES = 1024 * 1024;
const DEFAULT_PROJECT_LIMIT = 20;
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceName(source) {
  if (typeof source === "string") return source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return "unknown";
  return Object.keys(source)[0] ?? "unknown";
}

function isUserSession(source) {
  const normalized = source.toLowerCase();
  return normalized !== "exec" && !normalized.includes("subagent");
}

function normalizedPathKey(candidate) {
  const normalized = path.resolve(candidate);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeCodexPath(candidate) {
  if (typeof candidate !== "string") return candidate;
  if (candidate.startsWith("\\\\?\\UNC\\")) return `\\\\${candidate.slice(8)}`;
  if (candidate.startsWith("\\\\?\\")) return candidate.slice(4);
  return candidate;
}

function readFirstLine(filePath) {
  const fd = openSync(filePath, "r");
  const chunks = [];
  let total = 0;

  try {
    while (total < MAX_METADATA_BYTES) {
      const buffer = Buffer.alloc(Math.min(8192, MAX_METADATA_BYTES - total));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newlineIndex = chunk.indexOf(0x0a);
      if (newlineIndex !== -1) {
        chunks.push(chunk.subarray(0, newlineIndex));
        break;
      }
      chunks.push(chunk);
      total += bytesRead;
    }
  } finally {
    closeSync(fd);
  }

  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
}

export function parseSessionMetadataLine(line, { rolloutPath, updatedAtMs } = {}) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  if (event?.type !== "session_meta") return null;
  const payload = event.payload;
  if (
    !payload ||
    typeof payload.id !== "string" ||
    typeof payload.cwd !== "string" ||
    payload.cwd.trim() === ""
  ) {
    return null;
  }

  return {
    threadId: payload.id,
    cwd: payload.cwd,
    source: sourceName(payload.source),
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    rolloutPath,
  };
}

export function selectRecentProjects(
  records,
  { limit = DEFAULT_PROJECT_LIMIT, pathExists = existsSync } = {},
) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("limit must be a positive integer");
  }

  const projects = [];
  const seen = new Set();
  const sorted = [...records].sort((left, right) => right.updatedAtMs - left.updatedAtMs);

  for (const record of sorted) {
    if (!record || !isUserSession(record.source ?? "unknown")) continue;
    if (!pathExists(record.cwd)) continue;
    const key = normalizedPathKey(record.cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push({
      ...record,
      key,
      label: path.basename(path.resolve(record.cwd)) || record.cwd,
    });
    if (projects.length === limit) break;
  }

  return projects;
}

function collectRolloutFiles(directory, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRolloutFiles(entryPath, output);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output.push(entryPath);
    }
  }
}

function findStateDatabases(codexHome) {
  return readdirSync(codexHome, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^state_(\d+)\.sqlite$/.test(entry.name))
    .map((entry) => ({
      path: path.join(codexHome, entry.name),
      version: Number(entry.name.match(/^state_(\d+)\.sqlite$/)[1]),
    }))
    .sort((left, right) => right.version - left.version);
}

async function readStateDatabaseRecords(codexHome) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return [];
  }

  let databases;
  try {
    databases = findStateDatabases(codexHome);
  } catch {
    return [];
  }

  for (const candidate of databases) {
    let database;
    try {
      database = new DatabaseSync(candidate.path, { readOnly: true });
      const columns = new Set(
        database.prepare("PRAGMA table_info(threads)").all().map((column) => column.name),
      );
      if (!["id", "cwd", "source"].every((column) => columns.has(column))) continue;
      if (!["recency_at_ms", "updated_at_ms", "updated_at"].some((column) => columns.has(column))) {
        continue;
      }
      const recencyExpression = columns.has("recency_at_ms")
        ? "recency_at_ms"
        : columns.has("updated_at_ms")
          ? "updated_at_ms"
          : "updated_at * 1000";
      const archivedFilter = columns.has("archived") ? "WHERE archived = 0" : "";
      const rows = database.prepare(
        `SELECT id, cwd, source, ${recencyExpression} AS updated_at_ms ` +
        `FROM threads ${archivedFilter} ORDER BY ${recencyExpression} DESC`,
      ).all();
      return rows.map((row) => ({
        threadId: row.id,
        cwd: normalizeCodexPath(row.cwd),
        source: sourceName(row.source),
        updatedAtMs: Number(row.updated_at_ms),
        rolloutPath: null,
      }));
    } catch {
      // Older or concurrently migrating state databases fall back to rollout metadata.
    } finally {
      database?.close();
    }
  }

  return [];
}

function readRolloutRecords(codexHome) {
  const sessionsDirectory = path.join(codexHome, "sessions");
  if (!existsSync(sessionsDirectory)) return [];

  const files = [];
  collectRolloutFiles(sessionsDirectory, files);
  const candidates = files
    .map((rolloutPath) => {
      try {
        return { rolloutPath, updatedAtMs: statSync(rolloutPath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);

  const records = [];
  for (const candidate of candidates) {
    try {
      const metadata = parseSessionMetadataLine(readFirstLine(candidate.rolloutPath), candidate);
      if (metadata) records.push(metadata);
    } catch {
      // A partially written or concurrently replaced rollout is skipped on this refresh.
    }
  }
  return records;
}

export async function discoverRecentProjects({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  limit = DEFAULT_PROJECT_LIMIT,
} = {}) {
  let records = await readStateDatabaseRecords(codexHome);
  if (records.length === 0) records = readRolloutRecords(codexHome);
  return selectRecentProjects(records, { limit });
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildWatchdogChildScript({
  cwd,
  threadId,
  mode = "resume",
  nodePath = process.execPath,
  launcherPath = path.join(projectRoot, "src", "launcher.mjs"),
  label = path.basename(cwd),
}) {
  if (!cwd) throw new TypeError("cwd is required");
  if (mode === "resume" && !threadId) throw new TypeError("threadId is required in resume mode");
  if (!new Set(["resume", "new"]).has(mode)) throw new TypeError(`unsupported mode: ${mode}`);

  const argumentsList = ["-C", cwd];
  if (mode === "resume") argumentsList.push("resume", threadId);
  const invocation = [nodePath, launcherPath, ...argumentsList]
    .map(powerShellLiteral)
    .join(" ");

  return [
    "$env:CODEX_WATCHDOG_PROBE_ENABLED = '1'",
    `$Host.UI.RawUI.WindowTitle = ${powerShellLiteral(`Codex Watchdog - ${label}`)}`,
    `& ${invocation}`,
  ].join("\n");
}

function startPowerShellWindow(project, mode) {
  const childScript = buildWatchdogChildScript({
    cwd: project.cwd,
    threadId: project.threadId,
    mode,
    label: project.label,
  });
  const encodedCommand = Buffer.from(childScript, "utf16le").toString("base64");
  const startScript = [
    "Start-Process",
    "-FilePath 'powershell.exe'",
    `-WorkingDirectory ${powerShellLiteral(project.cwd)}`,
    `-ArgumentList @('-NoExit','-NoProfile','-EncodedCommand',${powerShellLiteral(encodedCommand)})`,
  ].join(" ");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", startScript],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell launcher exited with code ${code}`));
    });
  });
}

function formatTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestampMs));
}

function truncate(value, width) {
  if (width <= 1) return "";
  if (value.length <= width) return value;
  return `${value.slice(0, width - 1)}…`;
}

function renderMenu({ projects, cursor, selected, mode, scrollOffset }) {
  const outputWidth = Math.max(process.stdout.columns || 100, 60);
  const outputHeight = Math.max(process.stdout.rows || 30, 12);
  const visibleCount = Math.max(3, outputHeight - 8);
  const visible = projects.slice(scrollOffset, scrollOffset + visibleCount);
  const modeLabel = mode === "resume" ? "恢复最近会话" : "启动新会话";
  const lines = [
    "Codex Watchdog 项目菜单",
    `模式：${modeLabel}    已选择：${selected.size}/${projects.length}`,
    "请先停止桌面端同一任务，避免两个客户端同时操作一个会话。",
    "",
  ];

  visible.forEach((project, visibleIndex) => {
    const index = scrollOffset + visibleIndex;
    const pointer = index === cursor ? ">" : " ";
    const checkbox = selected.has(project.key) ? "[x]" : "[ ]";
    const source = project.source === "vscode" ? "桌面" : project.source;
    const prefix = `${pointer} ${checkbox} ${project.label}  ${formatTimestamp(project.updatedAtMs)}  ${source}  `;
    lines.push(prefix + truncate(project.cwd, outputWidth - prefix.length));
  });

  lines.push("");
  lines.push("↑↓ 移动  Space 勾选  A 全选  M 切换模式  Enter 启动  Esc 退出");
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}`);
}

async function chooseProjects(loadProjects) {
  const projects = await loadProjects();
  return new Promise((resolve) => {
    if (projects.length === 0) {
      resolve({ projects: [], selected: [], mode: "resume" });
      return;
    }

    let cursor = 0;
    let scrollOffset = 0;
    let mode = "resume";
    const selected = new Set();
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write("\x1b[?25l");

    const updateScroll = () => {
      const visibleCount = Math.max(3, Math.max(process.stdout.rows || 30, 12) - 8);
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + visibleCount) scrollOffset = cursor - visibleCount + 1;
    };
    const render = () => renderMenu({ projects, cursor, selected, mode, scrollOffset });
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
    };
    const finish = (selection) => {
      cleanup();
      resolve({ projects, selected: selection, mode });
    };

    const onKeypress = (character, key) => {
      if (key?.name === "up") cursor = (cursor - 1 + projects.length) % projects.length;
      else if (key?.name === "down") cursor = (cursor + 1) % projects.length;
      else if (key?.name === "space") {
        const keyValue = projects[cursor].key;
        if (selected.has(keyValue)) selected.delete(keyValue);
        else selected.add(keyValue);
      } else if (character?.toLowerCase() === "a") {
        if (selected.size === projects.length) selected.clear();
        else for (const project of projects) selected.add(project.key);
      } else if (character?.toLowerCase() === "m") {
        mode = mode === "resume" ? "new" : "resume";
      } else if (key?.name === "return") {
        finish(projects.filter((project) => selected.has(project.key)));
        return;
      } else if (key?.name === "escape" || (key?.ctrl && key?.name === "c")) {
        finish([]);
        return;
      }
      updateScroll();
      render();
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

export async function runProjectMenu() {
  if (process.platform !== "win32") {
    throw new Error("codex-watchdog menu currently supports Windows only");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("codex-watchdog menu requires an interactive terminal");
  }

  const loadProjects = () => discoverRecentProjects();
  const choice = await chooseProjects(loadProjects);
  if (choice.projects.length === 0) {
    process.stdout.write("没有发现可用的 Codex 项目会话。\n");
    return;
  }
  if (choice.selected.length === 0) {
    process.stdout.write("未启动任何项目。\n");
    return;
  }

  const failures = [];
  for (const project of choice.selected) {
    try {
      await startPowerShellWindow(project, choice.mode);
    } catch (error) {
      failures.push(`${project.cwd}: ${error.message}`);
    }
  }

  const launchedCount = choice.selected.length - failures.length;
  process.stdout.write(`已启动 ${launchedCount} 个 watchdog 项目窗口。\n`);
  if (failures.length > 0) {
    throw new Error(`以下项目启动失败：\n${failures.join("\n")}`);
  }
}
