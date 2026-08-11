import { createRequire } from "node:module";
import { readFile as readFileAsync } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { aggregateBalances, normalizeBalances, validateBalancePolicy } from "./balance.mjs";
import { selectBalanceAdapter } from "./balance-adapters.mjs";
import { ModelRecoveryGate } from "./model-recovery-gate.mjs";
import { createPluginHost } from "./plugin-host.mjs";

const CONFIG_API_VERSION = 1;

export function validatePluginName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid plugin name: ${String(name)}`);
  }
  return name;
}

export function resolvePluginConfigPath(
  name,
  { env = process.env, platform = process.platform } = {},
) {
  validatePluginName(name);
  const pathApi = platform === "win32" ? path.win32 : path;
  if (platform === "win32") {
    if (!env.APPDATA) throw new Error(`Could not resolve config for plugin ${name}: APPDATA is not set`);
    return pathApi.join(env.APPDATA, "codex-watchdog", "plugins", `${name}.json`);
  }
  const configHome = env.XDG_CONFIG_HOME || (env.HOME && pathApi.join(env.HOME, ".config"));
  if (!configHome) throw new Error(`Could not resolve config for plugin ${name}: HOME is not set`);
  return pathApi.join(configHome, "codex-watchdog", "plugins", `${name}.json`);
}

function isLocalModule(moduleName, pathApi) {
  return moduleName.startsWith(".") || pathApi.isAbsolute(moduleName);
}

function validateRuntimeConfig(name, config) {
  if (!["sub2api", "newapi", "custom"].includes(config.stack)) {
    throw new Error(`Plugin ${name} config stack is invalid`);
  }
  try {
    const baseUrl = new URL(config.baseUrl);
    if (!new Set(["http:", "https:"]).has(baseUrl.protocol)) throw new Error();
  } catch {
    throw new Error(`Plugin ${name} config baseUrl must be an absolute HTTP URL`);
  }
  if (typeof config.model !== "string" || config.model.trim() === "") {
    throw new Error(`Plugin ${name} config model must be non-empty`);
  }
  if (!Number.isFinite(config.probeIntervalMs) || config.probeIntervalMs <= 0) {
    throw new Error(`Plugin ${name} config probeIntervalMs must be positive`);
  }
  if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
    throw new Error(`Plugin ${name} config requestTimeoutMs must be positive`);
  }
  if (!Array.isArray(config.apiKeys) || config.apiKeys.length === 0) {
    throw new Error(`Plugin ${name} config apiKeys must not be empty`);
  }
  const ids = new Set();
  for (const apiKey of config.apiKeys) {
    if (
      typeof apiKey?.id !== "string" || apiKey.id.length === 0 ||
      typeof apiKey?.value !== "string" || apiKey.value.length === 0
    ) {
      throw new Error(`Plugin ${name} config API keys require id and value`);
    }
    if (ids.has(apiKey.id)) throw new Error(`Plugin ${name} config has duplicate API key ID`);
    ids.add(apiKey.id);
  }
  validateBalancePolicy(config.balancePolicy);
}

export async function loadPlugin(
  name,
  {
    env = process.env,
    platform = process.platform,
    configPath: suppliedConfigPath,
    readFile = (filePath) => readFileAsync(filePath, "utf8"),
    resolveModule,
    pathToFileURLImpl = (filePath) => pathToFileURL(filePath).href,
    importModule = (specifier) => import(specifier),
    host,
    logger = console,
  } = {},
) {
  validatePluginName(name);
  const configPath = suppliedConfigPath ?? resolvePluginConfigPath(name, { env, platform });
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read plugin ${name} config at ${configPath}: ${error.message}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid config for plugin ${name}`);
  }
  if (config.apiVersion !== CONFIG_API_VERSION) {
    throw new Error(`Plugin ${name} config apiVersion must be ${CONFIG_API_VERSION}`);
  }
  if (typeof config.module !== "string" || config.module.trim() === "") {
    throw new Error(`Plugin ${name} config module must be non-empty`);
  }
  validateRuntimeConfig(name, config);

  const pathApi = platform === "win32" ? path.win32 : path;
  let moduleSpecifier = config.module;
  let ownedPluginHost = null;
  try {
    if (isLocalModule(moduleSpecifier, pathApi)) {
      moduleSpecifier = pathApi.resolve(pathApi.dirname(configPath), moduleSpecifier);
    } else {
      const requireFromConfig = createRequire(configPath);
      const resolver = resolveModule ?? requireFromConfig.resolve.bind(requireFromConfig);
      moduleSpecifier = resolver(moduleSpecifier, configPath);
    }
    const loaded = await importModule(pathToFileURLImpl(moduleSpecifier));
    if (typeof loaded?.default !== "function") {
      throw new Error(`Plugin ${name} module must default-export a factory`);
    }
    const pluginHost = host ?? createPluginHost({ config, logger });
    if (!host) ownedPluginHost = pluginHost;
    const plugin = await loaded.default({ config, host: pluginHost });
    if (!plugin || typeof plugin !== "object") {
      throw new Error(`Plugin ${name} factory must return a plugin object`);
    }
    if (plugin.apiVersion !== CONFIG_API_VERSION) {
      throw new Error(`Plugin ${name} apiVersion must be ${CONFIG_API_VERSION}`);
    }
    if (typeof plugin.checkModel !== "function") {
      throw new Error(`Plugin ${name} must provide checkModel`);
    }
    const queryBalances = plugin.checkBalances?.bind(plugin)
      ?? selectBalanceAdapter(config.stack);
    const accountIds = config.apiKeys.map(({ id }) => id);
    const checkBalances = async (context = {}) => {
      let records;
      try {
        records = await queryBalances({
          ...context,
          config,
          http: pluginHost.http,
          logger: pluginHost.logger,
        });
      } catch (error) {
        pluginHost.logger?.warn?.(`Balance query failed: ${error?.message ?? error}`);
        records = accountIds.map((accountId) => ({ accountId, balance: null }));
      }
      return aggregateBalances(normalizeBalances(records, accountIds), config.balancePolicy);
    };
    const recoveryGate = new ModelRecoveryGate({
      checkModel: plugin.checkModel.bind(plugin),
      intervalMs: config.probeIntervalMs,
      logger: pluginHost.logger,
    });
    return {
      config,
      plugin,
      host: pluginHost,
      checkBalances,
      recoveryGate,
      async close() {
        recoveryGate.close();
        try {
          await plugin.close?.();
        } finally {
          pluginHost.close?.();
        }
      },
    };
  } catch (error) {
    ownedPluginHost?.close?.();
    if (error instanceof Error && error.message.startsWith("Plugin ")) throw error;
    throw new Error(`Could not load plugin ${name}: ${error.message}`);
  }
}
