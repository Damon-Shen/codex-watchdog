import { createSseRetryProxy } from "./sse-retry-proxy.mjs";

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
  const proxy = await createSseRetryProxy({
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
    logger: logger(),
  });

  const shutdown = async (signal) => {
    process.stderr.write(`${new Date().toISOString()} INFO Received ${signal}; shutting down\n`);
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
