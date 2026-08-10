import { createRequire } from "node:module";
import { readFile as readFileAsync } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

  const pathApi = platform === "win32" ? path.win32 : path;
  let moduleSpecifier = config.module;
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
    const plugin = await loaded.default({ config, host });
    if (!plugin || typeof plugin !== "object") {
      throw new Error(`Plugin ${name} factory must return a plugin object`);
    }
    if (plugin.apiVersion !== CONFIG_API_VERSION) {
      throw new Error(`Plugin ${name} apiVersion must be ${CONFIG_API_VERSION}`);
    }
    if (typeof plugin.checkModel !== "function") {
      throw new Error(`Plugin ${name} must provide checkModel`);
    }
    return plugin;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Plugin ")) throw error;
    throw new Error(`Could not load plugin ${name}: ${error.message}`);
  }
}
