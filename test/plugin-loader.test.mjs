import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  loadPlugin,
  resolvePluginConfigPath,
  validatePluginName,
} from "../src/plugin-loader.mjs";

function validConfig(overrides = {}) {
  return {
    apiVersion: 1,
    module: "./relay.mjs",
    stack: "sub2api",
    baseUrl: "https://relay.example",
    apiKeys: [{ id: "primary", value: "secret" }],
    model: "gpt-test",
    probeIntervalMs: 100,
    requestTimeoutMs: 50,
    balancePolicy: { mode: "any", minimum: 1 },
    ...overrides,
  };
}

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
  const config = validConfig();
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(path.join(path.dirname(configPath), "relay.mjs"),
    "export default ({ config, host }) => ({ apiVersion: 1, checkModel: async () => ({ config, host }) });");

  const runtime = await loadPlugin("relay", {
    env: { HOME: root },
    platform: "linux",
    host: { marker: true },
  });
  assert.equal(runtime.plugin.apiVersion, 1);
  assert.deepEqual(await runtime.plugin.checkModel(), {
    config,
    host: { marker: true },
  });
  await runtime.close();
});

test("supports injected package resolution and import", async () => {
  const configPath = "/home/test/.config/codex-watchdog/plugins/relay.json";
  const calls = [];
  const runtime = await loadPlugin("relay", {
    configPath,
    readFile: async () => JSON.stringify(validConfig({ module: "relay-package" })),
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
  assert.equal(runtime.plugin.checkModel(), "host");
  assert.deepEqual(calls, [["relay-package", configPath], ["import", pathToFileURL("/pkg/relay.mjs").href]]);
  await runtime.close();
});

test("converts POSIX local paths with URL-significant characters before import", async () => {
  const modulePath = "/tmp/plugin #relay%2Fv1.mjs";
  let imported;
  await loadPlugin("relay", {
    configPath: "/tmp/config/relay.json",
    readFile: async () => JSON.stringify(validConfig({ module: modulePath })),
    importModule: async (specifier) => {
      imported = specifier;
      return { default: () => ({ apiVersion: 1, checkModel: () => {} }) };
    },
  });
  assert.equal(imported, pathToFileURL(modulePath).href);
});

test("converts Windows local paths through the injectable file URL boundary", async () => {
  const modulePath = "C:\\Users\\test\\plugins\\relay #v1%.mjs";
  const conversions = [];
  let imported;
  await loadPlugin("relay", {
    platform: "win32",
    configPath: "C:\\Users\\test\\plugins\\config\\relay.json",
    readFile: async () => JSON.stringify(validConfig({ module: "..\\relay #v1%.mjs" })),
    pathToFileURLImpl: (value) => {
      conversions.push(value);
      return "file:///C:/Users/test/plugins/relay%20%23v1%25.mjs";
    },
    importModule: async (specifier) => {
      imported = specifier;
      return { default: () => ({ apiVersion: 1, checkModel: () => {} }) };
    },
  });
  assert.deepEqual(conversions, [modulePath]);
  assert.equal(imported, "file:///C:/Users/test/plugins/relay%20%23v1%25.mjs");
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
    readFile: async () => JSON.stringify(validConfig({ module: "relay" })),
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

test("redacts configured secrets from plugin factory errors", async () => {
  await assert.rejects(
    () => loadPlugin("relay", {
      configPath: "/tmp/relay.json",
      readFile: async () => JSON.stringify(validConfig()),
      importModule: async () => ({
        default: ({ config }) => {
          throw new Error(`factory rejected ${config.apiKeys[0].value}`);
        },
      }),
    }),
    (error) => {
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});

test("redacts configured secrets from plugin close errors", async () => {
  const runtime = await loadPlugin("relay", {
    configPath: "/tmp/relay.json",
    readFile: async () => JSON.stringify(validConfig()),
    importModule: async () => ({
      default: ({ config }) => ({
        apiVersion: 1,
        checkModel: async () => true,
        close() {
          throw new Error(`close rejected ${config.apiKeys[0].value}`);
        },
      }),
    }),
  });

  await assert.rejects(
    () => runtime.close(),
    (error) => {
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});

test("closes the plugin host before invoking plugin close", async () => {
  const events = [];
  const runtime = await loadPlugin("relay", {
    configPath: "/tmp/relay.json",
    readFile: async () => JSON.stringify(validConfig()),
    importModule: async () => ({
      default: () => ({
        apiVersion: 1,
        checkModel: async () => true,
        close() {
          events.push("plugin");
        },
      }),
    }),
    host: {
      close() {
        events.push("host");
      },
      logger: { info() {}, warn() {}, error() {} },
    },
  });

  await runtime.close();

  assert.deepEqual(events, ["host", "plugin"]);
});

test("assembles a normalized plugin runtime", async () => {
  const runtime = await loadPlugin("relay", {
    configPath: "/tmp/relay.json",
    readFile: async () => JSON.stringify(validConfig({
      module: "relay-package",
      stack: "custom",
      apiKeys: [{ id: "first", value: "secret" }],
    })),
    resolveModule: () => "/pkg/relay.mjs",
    importModule: async () => ({
      default: () => ({
        apiVersion: 1,
        checkModel: async () => true,
        checkBalances: async () => [{ accountId: "first", balance: 2 }],
      }),
    }),
    host: { logger: { warn() {} } },
  });

  assert.equal(runtime.plugin.apiVersion, 1);
  assert.equal(await runtime.checkBalances({}), "available");
  assert.equal(typeof runtime.recoveryGate.beginRecoveryCheck, "function");
  await runtime.close();
});

test("rejects invalid runtime settings before creating a plugin", async () => {
  const cases = [
    [validConfig({ stack: "other" }), /stack/i],
    [validConfig({ baseUrl: "/relative" }), /baseUrl/i],
    [validConfig({ model: "" }), /model/i],
    [validConfig({ probeIntervalMs: 0 }), /probeIntervalMs/i],
    [validConfig({ requestTimeoutMs: -1 }), /requestTimeoutMs/i],
    [validConfig({ apiKeys: [] }), /apiKeys/i],
    [validConfig({
      apiKeys: [
        { id: "same", value: "first" },
        { id: "same", value: "second" },
      ],
    }), /duplicate/i],
    [validConfig({ balancePolicy: { mode: "other", minimum: 1 } }), /balance policy/i],
  ];

  for (const [config, pattern] of cases) {
    await assert.rejects(() => loadPlugin("relay", {
      configPath: "/tmp/relay.json",
      readFile: async () => JSON.stringify(config),
      resolveModule: () => "/pkg/relay.mjs",
      importModule: async () => ({
        default: () => ({ apiVersion: 1, checkModel: async () => true }),
      }),
    }), pattern);
  }
});

test("requires a balance implementation for custom stacks", async () => {
  await assert.rejects(() => loadPlugin("relay", {
    configPath: "/tmp/relay.json",
    readFile: async () => JSON.stringify(validConfig({
      module: "relay-package",
      stack: "custom",
    })),
    resolveModule: () => "/pkg/relay.mjs",
    importModule: async () => ({
      default: () => ({ apiVersion: 1, checkModel: async () => true }),
    }),
  }), /custom.*checkBalances/i);
});
