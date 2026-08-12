import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

export const DEFAULT_RETRY_RULES = [
  { id: "http_429", label: "HTTP 429 / rate limit", kind: "status", value: "429", enabled: true, builtin: true },
  { id: "http_5xx", label: "HTTP 500/502/503/504", kind: "status", value: "500,502,503,504", enabled: true, builtin: true },
  { id: "capacity", label: "Selected model is at capacity", kind: "text", value: "Selected model is at capacity", enabled: true, builtin: true },
  { id: "overloaded", label: "server_overloaded / service unavailable", kind: "text", value: "server_overloaded|service_unavailable|temporarily_unavailable|service temporarily unavailable", enabled: true, builtin: true },
  { id: "rate_limit", label: "rate limit errors", kind: "text", value: "rate_limit_exceeded|rate limit", enabled: true, builtin: true },
  { id: "timeout", label: "timeout / timed out", kind: "text", value: "upstream_timeout|timed out|timeout", enabled: true, builtin: true },
  { id: "connection", label: "connection reset/refused", kind: "text", value: "connection reset|connection refused|network error|network failure", enabled: true, builtin: true },
  { id: "stream_disconnect", label: "stream disconnected before completion", kind: "text", value: "stream disconnected before completion|stream closed before response.completed", enabled: true, builtin: true },
  { id: "incomplete_stream", label: "SSE closed without terminal event", kind: "incomplete", value: "", enabled: true, builtin: true },
];

function normalizedRule(rule, index) {
  const kind = ["status", "text", "incomplete"].includes(rule?.kind) ? rule.kind : "text";
  return {
    id: typeof rule?.id === "string" && rule.id ? rule.id : `custom_${index}`,
    label: typeof rule?.label === "string" && rule.label ? rule.label : String(rule?.value || "Custom rule"),
    kind,
    value: typeof rule?.value === "string" ? rule.value : "",
    enabled: rule?.enabled !== false,
    builtin: rule?.builtin === true,
  };
}

export function normalizeRetryRules(payload) {
  const source = Array.isArray(payload?.rules) ? payload.rules : DEFAULT_RETRY_RULES;
  return { rules: source.map(normalizedRule).filter((rule) => rule.kind === "incomplete" || rule.value) };
}

export function ensureRetryRulesFile(filePath) {
  if (!existsSync(filePath)) writeFileSync(filePath, `${JSON.stringify({ rules: DEFAULT_RETRY_RULES }, null, 2)}\n`, "utf8");
}

export class DesktopRetryRules {
  #mtimeMs = null;
  #rules = DEFAULT_RETRY_RULES;
  constructor({ filePath, logger = console } = {}) { this.filePath = filePath; this.logger = logger; }
  snapshot() { this.#refresh(); return { file: this.filePath, enabled: this.#rules.filter((rule) => rule.enabled).length, total: this.#rules.length }; }
  matchesStatus(status) { this.#refresh(); return this.#rules.some((rule) => rule.enabled && rule.kind === "status" && rule.value.split(",").some((value) => Number(value.trim()) === status)); }
  matchesText(text) { this.#refresh(); const input = String(text || "").toLowerCase(); return this.#rules.some((rule) => rule.enabled && rule.kind === "text" && rule.value.split("|").some((value) => value.trim() && input.includes(value.trim().toLowerCase()))); }
  matchesIncomplete() { this.#refresh(); return this.#rules.some((rule) => rule.enabled && rule.kind === "incomplete"); }
  #refresh() {
    try {
      ensureRetryRulesFile(this.filePath);
      const mtimeMs = statSync(this.filePath).mtimeMs;
      if (mtimeMs === this.#mtimeMs) return;
      this.#rules = normalizeRetryRules(JSON.parse(readFileSync(this.filePath, "utf8"))).rules;
      this.#mtimeMs = mtimeMs;
    } catch (error) { this.logger?.warn?.(`Retry rules unchanged: ${error.message}`); }
  }
}
