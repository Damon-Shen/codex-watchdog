import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

function globalNpmRoot() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileSync(npmCommand, ["root", "--global"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

export function resolveCodexEntrypoint({
  env = process.env,
  exists = existsSync,
  resolveGlobalNpmRoot = globalNpmRoot,
} = {}) {
  const explicit = env.CODEX_WATCHDOG_CODEX_JS;
  if (explicit) {
    if (exists(explicit)) return explicit;
    throw new Error(`CODEX_WATCHDOG_CODEX_JS does not exist: ${explicit}`);
  }

  const npmRoots = [];
  try {
    const root = resolveGlobalNpmRoot();
    if (root) npmRoots.push(root);
  } catch {
    // The Windows fallback below still works when npm cannot report its global root.
  }
  if (env.APPDATA) npmRoots.push(path.join(env.APPDATA, "npm", "node_modules"));

  const candidates = [...new Set(npmRoots)].map((root) =>
    path.join(root, "@openai", "codex", "bin", "codex.js"));
  const entrypoint = candidates.find((candidate) => exists(candidate));
  if (entrypoint) return entrypoint;

  const searched = candidates.length > 0 ? candidates.join(", ") : "no npm roots were available";
  throw new Error(
    `Codex npm entrypoint was not found (${searched}); install Codex globally or set CODEX_WATCHDOG_CODEX_JS`,
  );
}

export function allocateTcpPort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export async function allocateDistinctTcpPorts(count, allocator = () => allocateTcpPort()) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }

  const ports = new Set();
  const maxAttempts = count * 20;
  for (let attempt = 0; ports.size < count && attempt < maxAttempts; attempt += 1) {
    ports.add(await allocator());
  }
  if (ports.size !== count) throw new Error(`Could not allocate ${count} distinct TCP ports`);
  return [...ports];
}

function argsBeforeOptionDelimiter(args) {
  const delimiterIndex = args.indexOf("--");
  return delimiterIndex === -1 ? args : args.slice(0, delimiterIndex);
}

export function extractWatchdogArgs(args) {
  const delimiterIndex = args.indexOf("--");
  const boundary = delimiterIndex === -1 ? args.length : delimiterIndex;
  let pluginName;
  const forwardedArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (index === delimiterIndex) {
      forwardedArgs.push(...args.slice(index));
      break;
    }
    if (args[index] !== "--plugin") {
      forwardedArgs.push(args[index]);
      continue;
    }
    if (pluginName !== undefined) throw new Error("Duplicate --plugin option");
    if (index + 1 >= boundary || args[index + 1] === "--plugin" || args[index + 1] === "--") {
      throw new Error("--plugin requires a value");
    }
    pluginName = args[index + 1];
    index += 1;
  }
  return { pluginName, forwardedArgs };
}

export function validateForwardedArgs(args) {
  const remoteArg = argsBeforeOptionDelimiter(args).find(
    (arg) => arg === "--remote" || arg.startsWith("--remote="),
  );
  if (remoteArg) {
    throw new Error("Do not pass --remote to codex-watchdog; the launcher manages that endpoint");
  }
}

export function ensureWorkingDirectoryArg(args, cwd) {
  const hasExplicitCwd = argsBeforeOptionDelimiter(args).some(
    (arg) =>
      arg === "-C" ||
      /^-C.+/.test(arg) ||
      arg === "--cd" ||
      arg.startsWith("--cd="),
  );
  return hasExplicitCwd ? args : ["-C", cwd, ...args];
}

export function parseNonNegativeMilliseconds(value, defaultValue, variableName) {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${variableName} must be a non-negative number of milliseconds`);
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForHttpReady(
  url,
  { timeoutMs = 15_000, intervalMs = 100, fetchImpl = fetch } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) return;
      lastError = new Error(`readiness probe returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "not ready"}`);
}
