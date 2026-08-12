import { createSseRetryProxy } from "./sse-retry-proxy.mjs";
import { ModelAvailabilityMonitor } from "./model-availability-monitor.mjs";
import {
  DesktopThreadPolicy,
  readThreadIdFromResponsesBody,
} from "./desktop-thread-policy.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopRetryRules, ensureRetryRulesFile } from "./desktop-retry-rules.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parsePort(value, defaultValue, variableName) {
  if (value == null || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${variableName} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function parseBytes(value, defaultValue, variableName) {
  if (value == null || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${variableName} must be a positive integer`);
  }
  return parsed;
}

function parseDelays(value) {
  if (value == null || value === "") return [1_000, 3_000, 10_000, 30_000, 60_000];
  const delays = value.split(",").map((part) => Number(part.trim()));
  if (delays.length === 0 || delays.some((delayMs) => !Number.isFinite(delayMs) || delayMs < 0)) {
    throw new Error("CODEX_DESKTOP_PROXY_RETRY_DELAYS_MS must contain non-negative milliseconds");
  }
  return delays;
}

function parseBoolean(value, defaultValue, variableName) {
  if (value == null || value === "") return defaultValue;
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${variableName} must be enabled or disabled`);
}

function requestIdentity({ body }) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return {};
  }
  const identity = {};
  for (const key of ["conversation", "conversation_id", "thread_id", "prompt_cache_key"]) {
    if (typeof payload?.[key] === "string" && payload[key].length <= 256) identity[key] = payload[key];
  }
  if (payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)) {
    identity.metadata_keys = Object.keys(payload.metadata).slice(0, 32);
  }
  return identity;
}

function logger() {
  const write = (level, message) => process.stderr.write(
    `${new Date().toISOString()} ${level} ${message}\n`,
  );
  return {
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
  };
}

async function main() {
  const log = logger();
  const monitorEnabled = parseBoolean(
    process.env.CODEX_DESKTOP_MODEL_MONITOR_ENABLED,
    false,
    "CODEX_DESKTOP_MODEL_MONITOR_ENABLED",
  );
  const logRequestIdentity = parseBoolean(
    process.env.CODEX_DESKTOP_LOG_REQUEST_IDENTITY,
    false,
    "CODEX_DESKTOP_LOG_REQUEST_IDENTITY",
  );
  const monitor = monitorEnabled ? new ModelAvailabilityMonitor({
    url: process.env.CODEX_DESKTOP_MODEL_MONITOR_URL || "https://status.input.im/api/status",
    targetModel: process.env.CODEX_DESKTOP_MODEL_MONITOR_MODEL || "gpt-5.6-sol",
    intervalMs: parseBytes(
      process.env.CODEX_DESKTOP_MODEL_MONITOR_INTERVAL_MS,
      60_000,
      "CODEX_DESKTOP_MODEL_MONITOR_INTERVAL_MS",
    ),
    requestTimeoutMs: parseBytes(
      process.env.CODEX_DESKTOP_MODEL_MONITOR_TIMEOUT_MS,
      5_000,
      "CODEX_DESKTOP_MODEL_MONITOR_TIMEOUT_MS",
    ),
    logger: log,
  }) : null;
  const threadPolicy = new DesktopThreadPolicy({
    filePath: process.env.CODEX_DESKTOP_THREAD_POLICY_FILE || path.join(
      projectRoot,
      "desktop-watchdog.policy.json",
    ),
    logger: log,
  });
  const retryRulesFile = process.env.CODEX_DESKTOP_RETRY_RULES_FILE || path.join(projectRoot, "desktop-watchdog.retry-rules.json");
  ensureRetryRulesFile(retryRulesFile);
  const retryRules = new DesktopRetryRules({ filePath: retryRulesFile, logger: log });
  monitor?.start();

  let proxy;
  try {
    proxy = await createSseRetryProxy({
    listenHost: process.env.CODEX_DESKTOP_PROXY_HOST || "127.0.0.1",
    listenPort: parsePort(
      process.env.CODEX_DESKTOP_PROXY_PORT,
      3001,
      "CODEX_DESKTOP_PROXY_PORT",
    ),
    upstreamOrigin: process.env.CODEX_DESKTOP_PROXY_UPSTREAM || "http://127.0.0.1:3000",
    retryDelaysMs: parseDelays(process.env.CODEX_DESKTOP_PROXY_RETRY_DELAYS_MS),
    maxRequestBytes: parseBytes(
      process.env.CODEX_DESKTOP_PROXY_MAX_REQUEST_BYTES,
      64 * 1024 * 1024,
      "CODEX_DESKTOP_PROXY_MAX_REQUEST_BYTES",
    ),
    maxBufferedResponseBytes: parseBytes(
      process.env.CODEX_DESKTOP_PROXY_MAX_RESPONSE_BYTES,
      64 * 1024 * 1024,
      "CODEX_DESKTOP_PROXY_MAX_RESPONSE_BYTES",
    ),
      logger: log,
      retryRules,
      requestGate: monitor ? async ({ body, signal }) => {
        const threadId = readThreadIdFromResponsesBody(body);
        if (!threadPolicy.shouldMonitor(threadId)) return;
        if (!monitor.available) {
          log.info(`Responses request paused for ${threadId ?? "unknown thread"}; waiting for ${monitor.snapshot().model}`);
        }
        await monitor.waitUntilAvailable({ signal });
      } : null,
      statusProvider: () => ({
        ...(monitor?.snapshot() ?? { enabled: false, state: "disabled" }),
        policy: threadPolicy.snapshot(),
        retryRules: retryRules.snapshot(),
      }),
      requestObserver: logRequestIdentity ? (request) => {
        const identity = requestIdentity(request);
        log.info(`Responses request identity: ${JSON.stringify(identity)}`);
      } : null,
    });
  } catch (error) {
    monitor?.close();
    throw error;
  }

  const shutdown = async (signal) => {
    process.stderr.write(`${new Date().toISOString()} INFO Received ${signal}; shutting down\n`);
    monitor?.close();
    await proxy.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      shutdown(signal)
        .then(() => { process.exitCode = signal === "SIGINT" ? 130 : 143; })
        .catch((error) => {
          process.stderr.write(`${error.stack ?? error.message}\n`);
          process.exitCode = 1;
        });
    });
  }
}

main().catch((error) => {
  process.stderr.write(`[desktop-proxy] ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
