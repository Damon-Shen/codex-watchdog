import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  allocateDistinctTcpPorts,
  allocateTcpPort,
  ensureWorkingDirectoryArg,
  extractWatchdogArgs,
  parseNonNegativeMilliseconds,
  resolveCodexEntrypoint,
  validateForwardedArgs,
  waitForHttpReady,
} from "./launcher-support.mjs";
import { loadPlugin } from "./plugin-loader.mjs";
import { createWatchdogProxy } from "./proxy.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
const DEFAULT_INTERRUPT_AFTER_MS = 120_000;

function parseDelays(value) {
  if (!value) return DEFAULT_DELAYS_MS;
  const delays = value.split(",").map((part) => Number(part.trim()));
  if (delays.length === 0 || delays.some((delayMs) => !Number.isFinite(delayMs) || delayMs < 0)) {
    throw new Error("CODEX_WATCHDOG_DELAYS_MS must be a comma-separated list of milliseconds");
  }
  return delays;
}

function createFileLogger(logPath) {
  const fd = openSync(logPath, "a");
  const write = (level, message) => {
    writeSync(fd, `${new Date().toISOString()} ${level} ${message}\n`);
  };
  return {
    fd,
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
  };
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return once(child, "exit").then(([code, signal]) => ({ code, signal }));
}

async function terminateChild(child, signal = "SIGTERM") {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = waitForExit(child);
  child.kill(signal);
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!graceful && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

async function main() {
  const logDir = path.join(projectRoot, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `watchdog-${new Date().toISOString().slice(0, 10)}.log`);
  const logger = createFileLogger(logPath);
  const host = "127.0.0.1";
  let appServer;
  let tui;
  let proxy;
  let pluginRuntime;
  let requestedSignal = null;
  let resolveSignal;
  const signalPromise = new Promise((resolve) => { resolveSignal = resolve; });
  const signalHandlers = new Map();

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (requestedSignal) return;
      requestedSignal = signal;
      logger.info(`Received ${signal}; shutting down`);
      resolveSignal({ type: "signal", signal });
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const {
      pluginName,
      forwardedArgs,
    } = extractWatchdogArgs(process.argv.slice(2));
    validateForwardedArgs(forwardedArgs);
    if (pluginName) pluginRuntime = await loadPlugin(pluginName, { logger });
    const codexEntrypoint = resolveCodexEntrypoint();
    const delaysMs = parseDelays(process.env.CODEX_WATCHDOG_DELAYS_MS);
    const interruptAfterMs = parseNonNegativeMilliseconds(
      process.env.CODEX_WATCHDOG_INTERRUPT_AFTER_MS,
      DEFAULT_INTERRUPT_AFTER_MS,
      "CODEX_WATCHDOG_INTERRUPT_AFTER_MS",
    );
    const launchCwd = process.cwd();
    const tuiArgs = ensureWorkingDirectoryArg(forwardedArgs, launchCwd);
    const [appServerPort, proxyPort] = await allocateDistinctTcpPorts(
      2,
      () => allocateTcpPort(host),
    );
    const appServerUrl = `ws://${host}:${appServerPort}`;

    appServer = spawn(
      process.execPath,
      [codexEntrypoint, "app-server", "--listen", appServerUrl],
      {
        cwd: launchCwd,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", logger.fd, logger.fd],
      },
    );
    appServer.once("error", (error) => logger.error(`Failed to start app-server: ${error.message}`));
    await waitForHttpReady(`http://${host}:${appServerPort}/readyz`);
    logger.info(`Codex app-server ready at ${appServerUrl}`);

    proxy = await createWatchdogProxy({
      listenHost: host,
      listenPort: proxyPort,
      upstreamUrl: appServerUrl,
      delaysMs,
      interruptAfterMs,
      recoveryGate: pluginRuntime?.recoveryGate ?? null,
      checkBalances: pluginRuntime?.checkBalances ?? null,
      logger,
    });

    process.stderr.write(`[goal-watchdog] enabled; log: ${logPath}\n`);
    tui = spawn(process.execPath, [codexEntrypoint, "--remote", proxy.url, ...tuiArgs], {
      cwd: launchCwd,
      env: process.env,
      windowsHide: false,
      stdio: "inherit",
    });
    tui.once("error", (error) => logger.error(`Failed to start TUI: ${error.message}`));

    const outcome = await Promise.race([
      waitForExit(tui).then((result) => ({ type: "tui", ...result })),
      waitForExit(appServer).then((result) => ({ type: "app-server", ...result })),
      signalPromise,
    ]);

    if (outcome.type === "app-server") {
      logger.error(`App-server exited unexpectedly with code ${outcome.code}`);
      await terminateChild(tui);
      process.exitCode = outcome.code ?? 1;
    } else if (outcome.type === "signal") {
      await terminateChild(tui, outcome.signal);
      process.exitCode = outcome.signal === "SIGINT" ? 130 : 143;
    } else {
      process.exitCode = outcome.code ?? (outcome.signal ? 1 : 0);
    }
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    try {
      if (proxy) await proxy.close();
    } catch (error) {
      logger.error(`Failed to close watchdog proxy: ${error.message}`);
    }
    try {
      if (pluginRuntime) await pluginRuntime.close();
    } catch (error) {
      logger.error(`Failed to close plugin runtime: ${error.message}`);
    }
    try {
      await terminateChild(tui);
    } catch (error) {
      logger.error(`Failed to terminate TUI: ${error.message}`);
    }
    try {
      await terminateChild(appServer);
    } catch (error) {
      logger.error(`Failed to terminate app-server: ${error.message}`);
    }
    closeSync(logger.fd);
  }
}

main().catch((error) => {
  process.stderr.write(`[goal-watchdog] ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
