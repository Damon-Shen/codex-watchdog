import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function latestDatabase(codexHome) {
  return readdirSync(codexHome).filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))
    .map((name) => path.join(codexHome, name))[0];
}

function sidebarTitle(value) {
  const singleLine = String(value || "Untitled conversation").replace(/\s+/g, " ").trim();
  return singleLine.length <= 180 ? singleLine : `${singleLine.slice(0, 179)}…`;
}

export function loadManagerProjects({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  projectsFile = process.env.CODEX_DESKTOP_PROJECTS_FILE || path.join(projectRoot(), "desktop-watchdog.projects.json"),
  titlesFile = process.env.CODEX_DESKTOP_TITLES_FILE || path.join(projectRoot(), "desktop-watchdog.title-cache.json"),
} = {}) {
  const file = latestDatabase(codexHome);
  if (!file) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id,title,cwd,recency_at_ms,is_pinned,thread_section_id,section_position,archived FROM threads WHERE archived=0 AND (thread_source='user' OR source IN ('cli','vscode')) ORDER BY recency_at_ms DESC").all();
    const projectOrder = readProjectOrder(projectsFile);
    const allowed = new Map(projectOrder.map((project, index) => [project.path.toLowerCase(), { ...project, index }]));
    const titles = readTitleCache(titlesFile);
    const groups = new Map();
    for (const row of rows) {
      const cwd = String(row.cwd || "").replace(/^\\\\\?\\/, "");
      const key = cwd.toLowerCase();
      if (allowed.size > 0 && !allowed.has(key)) continue;
      if (!groups.has(key)) groups.set(key, { path: cwd, name: allowed.get(key)?.label || path.basename(cwd) || cwd || "No project", threads: [], recent: 0 });
      const group = groups.get(key);
      group.recent = Math.max(group.recent, Number(row.recency_at_ms || 0));
      group.threads.push({ id: String(row.id), title: sidebarTitle(titles[String(row.id)] || row.title), recent: Number(row.recency_at_ms || 0), pinned: Boolean(row.is_pinned) });
    }
    for (const group of groups.values()) group.threads.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.recent - a.recent);
    return [...groups.values()].sort((a, b) => (allowed.get(a.path.toLowerCase())?.index ?? 9999) - (allowed.get(b.path.toLowerCase())?.index ?? 9999) || b.recent - a.recent);
  } finally { db.close(); }
}

function projectRoot() { return path.dirname(path.dirname(fileURLToPath(import.meta.url))); }
function readProjectOrder(filePath) {
  try {
    const payload = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(payload?.projects) ? payload.projects.filter((project) => typeof project?.path === "string" && project.path.trim()) : [];
  } catch { return []; }
}
function readTitleCache(filePath) {
  try { const payload = JSON.parse(readFileSync(filePath, "utf8")); return payload?.titles && typeof payload.titles === "object" ? payload.titles : {}; } catch { return {}; }
}

export function readManagerPolicy(filePath) {
  try { return JSON.parse(readFileSync(filePath, "utf8")); } catch { return { default: "bypass", threads: {} }; }
}

export function writeManagerPolicy(filePath, policy) {
  const normalized = { default: policy.default === "monitor" ? "monitor" : "bypass", threads: {} };
  for (const [id, mode] of Object.entries(policy.threads || {})) if (mode === "monitor" || mode === "bypass") normalized.threads[id] = mode;
  writeFileSync(`${filePath}.tmp`, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  renameSync(`${filePath}.tmp`, filePath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(loadManagerProjects()));
}
