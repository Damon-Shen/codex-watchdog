import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadPlugin,
  resolvePluginConfigPath,
  validatePluginName,
} from "../src/plugin-loader.mjs";

test("validates plugin names and rejects path-like names", () => {
  assert.equal(validatePluginName("relay-v1_2"), "relay-v1_2");
  for (const name of ["", "../relay", "relay/name", "relay\\name", "relay name", "."]) {
    assert.throws(() => validatePluginName(name), /plugin name/i);
  }
});

test("resolves POSIX XDG and HOME fallback config paths", () => {
  assert.equal(
    resolvePluginConfigPath("relay", {
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/xdg", HOME: "/home/test" },
    }),
    "/xdg/codex-watchdog/plugins/relay.json",
  );
  assert.equal(
    resolvePluginConfigPath("relay", { platform: "linux", env: { HOME: "/home/test" } }),
    "/home/test/.config/codex-watchdog/plugins/relay.json",
  );
});

test("resolves Windows APPDATA config path", () => {
  assert.equal(
    resolvePluginConfigPath("relay", {
      platform: "win32",
      env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
    }),
    path.win32.join("C:\\Users\\test\\AppData\\Roaming", "codex-watchdog", "plugins", "relay.json"),
  );
});

test("loads a relative local ESM module from a validated config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "watchdog-plugin-"));
  const configPath = path.join(root, ".config", "codex-watchdog", "plugins", "relay.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ apiVersion: 1, module: "./relay.mjs" }));
  await writeFile(path.join(path.dirname(configPath), "relay.mjs"),
    "export default ({ config, host }) => ({ apiVersion: 1, checkModel: async () => ({ config, host }) });");

  const plugin = await loadPlugin("relay", {
    env: { HOME: root },
    platform: "linux",
    host: { marker: true },
  });
  assert.equal(plugin.apiVersion, 1);
  assert.deepEqual(await plugin.checkModel(), {
    config: { apiVersion: 1, module: "./relay.mjs" },
    host: { marker: true },
  });
});

test("supports injected package resolution and import", async () => {
  const configPath = "/home/test/.config/codex-watchdog/plugins/relay.json";
  const calls = [];
  const plugin = await loadPlugin("relay", {
    configPath,
    readFile: async () => JSON.stringify({ apiVersion: 1, module: "relay-package" }),
    resolveModule: (specifier, parent) => {
      calls.push([specifier, parent]);
      return "/pkg/relay.mjs";
    },
    importModule: async (specifier) => {
      calls.push(["import", specifier]);
      return { default: ({ host }) => ({ apiVersion: 1, checkModel: () => host }) };
    },
    host: "host",
  });
  assert.equal(plugin.checkModel(), "host");
  assert.deepEqual(calls, [["relay-package", configPath], ["import", "/pkg/relay.mjs"]]);
});

test("rejects missing, invalid, and incompatible plugin configurations", async () => {
  const options = {
    configPath: "/tmp/relay.json",
    readFile: async () => "{}",
  };
  await assert.rejects(() => loadPlugin("relay", options), /config/i);
  await assert.rejects(() => loadPlugin("relay", {
    ...options,
    readFile: async () => JSON.stringify({ apiVersion: 2, module: "relay" }),
  }), /apiVersion/i);
  await assert.rejects(() => loadPlugin("relay", {
    ...options,
    readFile: async () => JSON.stringify({ apiVersion: 1, module: "" }),
  }), /module/i);
  await assert.rejects(() => loadPlugin("relay", {
    ...options,
    readFile: async () => { throw new Error("ENOENT"); },
  }), /relay|config/i);
});

test("rejects modules without a factory or with invalid plugin APIs", async () => {
  const base = {
    configPath: "/tmp/relay.json",
    readFile: async () => JSON.stringify({ apiVersion: 1, module: "relay" }),
    resolveModule: () => "/pkg/relay.mjs",
    importModule: async () => ({ default: "not a factory" }),
  };
  await assert.rejects(() => loadPlugin("relay", base), /factory/i);
  await assert.rejects(() => loadPlugin("relay", {
    ...base,
    importModule: async () => ({ default: () => ({ apiVersion: 2, checkModel: () => {} }) }),
  }), /apiVersion/i);
  await assert.rejects(() => loadPlugin("relay", {
    ...base,
    importModule: async () => ({ default: () => ({ apiVersion: 1 }) }),
  }), /checkModel/i);
});
