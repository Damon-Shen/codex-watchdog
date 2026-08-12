import { existsSync, readFileSync, statSync } from "node:fs";

const MODES = new Set(["monitor", "bypass"]);

function normalizedPolicy(payload) {
  const defaultMode = MODES.has(payload?.default) ? payload.default : "bypass";
  const threads = {};
  if (payload?.threads && typeof payload.threads === "object" && !Array.isArray(payload.threads)) {
    for (const [threadId, mode] of Object.entries(payload.threads)) {
      if (typeof threadId === "string" && MODES.has(mode)) threads[threadId] = mode;
    }
  }
  return { default: defaultMode, threads };
}

export function parseThreadPolicy(text) {
  return normalizedPolicy(JSON.parse(text));
}

export function readThreadIdFromResponsesBody(body) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
  return typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.length <= 256
    ? payload.prompt_cache_key
    : null;
}

export class DesktopThreadPolicy {
  #mtimeMs = null;
  #policy = { default: "bypass", threads: {} };
  #lastWarning = null;

  constructor({ filePath, logger = console } = {}) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new TypeError("filePath must be non-empty");
    }
    this.filePath = filePath;
    this.logger = logger;
  }

  shouldMonitor(threadId) {
    this.#refresh();
    if (typeof threadId === "string" && threadId in this.#policy.threads) {
      return this.#policy.threads[threadId] === "monitor";
    }
    return this.#policy.default === "monitor";
  }

  snapshot() {
    this.#refresh();
    return {
      file: this.filePath,
      default: this.#policy.default,
      monitoredCount: Object.values(this.#policy.threads).filter((mode) => mode === "monitor").length,
      bypassedCount: Object.values(this.#policy.threads).filter((mode) => mode === "bypass").length,
    };
  }

  #refresh() {
    try {
      if (!existsSync(this.filePath)) {
        this.#policy = { default: "bypass", threads: {} };
        this.#mtimeMs = null;
        return;
      }
      const mtimeMs = statSync(this.filePath).mtimeMs;
      if (mtimeMs === this.#mtimeMs) return;
      this.#policy = parseThreadPolicy(readFileSync(this.filePath, "utf8"));
      this.#mtimeMs = mtimeMs;
      this.#lastWarning = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.#lastWarning) {
        this.logger?.warn?.(`Thread policy ignored; using last valid policy: ${message}`);
        this.#lastWarning = message;
      }
    }
  }
}
