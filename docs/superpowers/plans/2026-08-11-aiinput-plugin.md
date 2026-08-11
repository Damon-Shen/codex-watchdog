# ai.input.im Relay Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a copyable ai.input.im ESM plugin and Sub2API configuration that work with `codex-watchdog --plugin aiinput`.

**Architecture:** The site plugin owns only the fixed `status.input.im` request and exact model-status parsing. The existing plugin runtime owns Sub2API balance queries, multi-key aggregation, cancellation, timeout, redaction, confirmation sampling, and Codex recovery.

**Tech Stack:** Node.js 22 ESM, native `node:test`, existing plugin host and loader, JSON configuration.

---

### Task 1: ai.input.im model status plugin

**Files:**
- Create: `plugins/aiinput.mjs`
- Create: `test/aiinput-plugin.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing success-path tests**

Create `test/aiinput-plugin.test.mjs` with a fake host that records requests and returns controlled
payloads. Exercise the plugin factory instead of exporting parser internals:

```js
import assert from "node:assert/strict";
import test from "node:test";

import createAiInputPlugin from "../plugins/aiinput.mjs";

function createHarness({ ok = true, status = 200, payload, jsonError } = {}) {
  const requests = [];
  const host = {
    http: {
      async request(request) {
        requests.push(request);
        return {
          ok,
          status,
          async json() {
            if (jsonError) throw jsonError;
            return payload;
          },
        };
      },
    },
  };
  return { host, requests };
}

test("returns the exact ai.input.im model status and forwards cancellation", async () => {
  for (const expected of [true, false]) {
    const signal = new AbortController().signal;
    const { host, requests } = createHarness({
      payload: {
        services: [
          { model: "gpt-5.6-sol-preview", last: { ok: !expected } },
          { model: "gpt-5.6-sol", last: { ok: expected } },
        ],
      },
    });
    const plugin = createAiInputPlugin({
      config: { model: "gpt-5.6-sol" },
      host,
    });

    assert.equal(await plugin.checkModel({ signal }), expected);
    assert.deepEqual(requests, [{
      url: "https://status.input.im/api/status",
      signal,
    }]);
    assert.equal(plugin.apiVersion, 1);
    assert.equal(plugin.id, "aiinput");
    assert.equal(plugin.checkBalances, undefined);
  }
});
```

- [ ] **Step 2: Run the success-path test and verify failure**

Run:

```bash
node --test test/aiinput-plugin.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `plugins/aiinput.mjs`.

- [ ] **Step 3: Implement the minimal plugin**

Create `plugins/aiinput.mjs`:

```js
const STATUS_URL = "https://status.input.im/api/status";

export default function createAiInputPlugin({ config, host }) {
  return {
    apiVersion: 1,
    id: "aiinput",

    async checkModel({ signal }) {
      const response = await host.http.request({ url: STATUS_URL, signal });
      const payload = await response.json();
      const service = payload.services.find((entry) =>
        entry && typeof entry === "object" && entry.model === config.model);
      return service.last.ok;
    },
  };
}
```

- [ ] **Step 4: Run the focused test and verify success**

Run:

```bash
node --test test/aiinput-plugin.test.mjs
```

Expected: PASS with 1 test and 0 failures.

- [ ] **Step 5: Add failing error-semantic tests**

Append table-driven cases for non-2xx, malformed JSON, missing `services`, missing exact model, and a
non-boolean `last.ok`:

```js
test("turns ambiguous ai.input.im responses into probe errors", async () => {
  const cases = [
    [{ ok: false, status: 503, payload: {} }, /HTTP 503/],
    [{ jsonError: new SyntaxError("invalid JSON") }, /invalid JSON/],
    [{ payload: {} }, /services array/],
    [{ payload: { services: [{ model: "other", last: { ok: true } }] } }, /no model/],
    [{ payload: { services: [{ model: "gpt-5.6-sol", last: { ok: "yes" } }] } }, /boolean status/],
  ];

  for (const [response, pattern] of cases) {
    const { host } = createHarness(response);
    const plugin = createAiInputPlugin({
      config: { model: "gpt-5.6-sol" },
      host,
    });
    await assert.rejects(() => plugin.checkModel({}), pattern);
  }
});
```

- [ ] **Step 6: Run the error tests and verify the intended intermediate failure**

Run:

```bash
node --test test/aiinput-plugin.test.mjs
```

Expected: FAIL. The malformed JSON case already passes through its `SyntaxError`; the non-2xx,
missing `services`, missing model, and non-boolean status cases fail because Step 3 has not implemented
their contract checks.

- [ ] **Step 7: Implement the error-contract guards**

Replace the body of `checkModel` with the complete validated flow:

```js
const response = await host.http.request({ url: STATUS_URL, signal });
if (!response.ok) {
  throw new Error(`ai.input.im status request failed with HTTP ${response.status}`);
}
const payload = await response.json();
if (!Array.isArray(payload?.services)) {
  throw new Error("ai.input.im status response has no services array");
}
const service = payload.services.find((entry) =>
  entry && typeof entry === "object" && entry.model === config.model);
if (!service) {
  throw new Error(`ai.input.im status response has no model named ${config.model}`);
}
if (typeof service.last?.ok !== "boolean") {
  throw new Error(`ai.input.im model ${config.model} has no boolean status`);
}
return service.last.ok;
```

- [ ] **Step 8: Add the shipped plugin to the static check**

Prepend the plugin syntax check to the existing `check` script in `package.json`:

```json
{
  "scripts": {
    "check": "node --check plugins/aiinput.mjs && node --check src/balance-adapters.mjs && node --check src/balance.mjs && node --check src/controller.mjs && node --check src/launcher-support.mjs && node --check src/launcher.mjs && node --check src/model-recovery-gate.mjs && node --check src/plugin-host.mjs && node --check src/plugin-loader.mjs && node --check src/policy.mjs && node --check src/proxy.mjs && node --check src/rpc-channel.mjs"
  }
}
```

- [ ] **Step 9: Run syntax and focused checks**

Run:

```bash
node --check plugins/aiinput.mjs
node --test test/aiinput-plugin.test.mjs
git diff --check
```

Expected: all commands exit 0; 2 tests pass.

- [ ] **Step 10: Commit the plugin**

```bash
git add plugins/aiinput.mjs test/aiinput-plugin.test.mjs package.json
git commit -m "feat: add aiinput model status plugin"
```

### Task 2: Copyable configuration and setup documentation

**Files:**
- Create: `plugins/aiinput.example.json`
- Modify: `test/aiinput-plugin.test.mjs`
- Modify: `docs/plugins/README.md`

- [ ] **Step 1: Write the failing configuration test**

Append a test that parses and loads the real example without making network requests:

```js
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadPlugin } from "../src/plugin-loader.mjs";

test("ships a loadable multi-account Sub2API configuration", async () => {
  const configUrl = new URL("../plugins/aiinput.example.json", import.meta.url);
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  assert.equal(config.module, "./aiinput.mjs");
  assert.equal(config.stack, "sub2api");
  assert.equal(config.baseUrl, "https://ai.input.im");
  assert.equal(config.apiKeys.length, 2);

  const runtime = await loadPlugin("aiinput", {
    configPath: fileURLToPath(configUrl),
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(runtime.plugin.id, "aiinput");
  assert.equal(runtime.plugin.checkBalances, undefined);
  await runtime.close();
});
```

- [ ] **Step 2: Run the configuration test and verify failure**

Run:

```bash
node --test --test-name-pattern="loadable multi-account" test/aiinput-plugin.test.mjs
```

Expected: FAIL with `ENOENT` for `plugins/aiinput.example.json`.

- [ ] **Step 3: Add the example configuration**

Create `plugins/aiinput.example.json`:

```json
{
  "apiVersion": 1,
  "module": "./aiinput.mjs",
  "stack": "sub2api",
  "baseUrl": "https://ai.input.im",
  "apiKeys": [
    { "id": "subscription-a", "value": "replace-with-api-key-a" },
    { "id": "subscription-b", "value": "replace-with-api-key-b" }
  ],
  "model": "gpt-5.6-sol",
  "probeIntervalMs": 30000,
  "requestTimeoutMs": 4000,
  "balancePolicy": { "mode": "any", "minimum": 1 },
  "options": {}
}
```

- [ ] **Step 4: Run the configuration test and verify success**

Run:

```bash
node --test test/aiinput-plugin.test.mjs
```

Expected: PASS with 3 tests and 0 failures. Loading the runtime must not issue HTTP requests.

- [ ] **Step 5: Document POSIX installation**

Add an `ai.input.im` section to `docs/plugins/README.md` containing these commands and explain that
the user edits `aiinput.json` before launch:

```bash
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-watchdog/plugins"
mkdir -p "$config_dir"
cp plugins/aiinput.mjs "$config_dir/aiinput.mjs"
cp plugins/aiinput.example.json "$config_dir/aiinput.json"
chmod 600 "$config_dir/aiinput.json"
codex-watchdog --plugin aiinput
```

Document replacement of `model`, every `apiKeys[].value`, account IDs, `balancePolicy.minimum`, and
the ability to add more key records.

- [ ] **Step 6: Document Windows installation**

In the same section add PowerShell commands:

```powershell
$configDir = Join-Path $env:APPDATA "codex-watchdog\plugins"
New-Item -ItemType Directory -Force $configDir | Out-Null
Copy-Item plugins\aiinput.mjs (Join-Path $configDir "aiinput.mjs")
Copy-Item plugins\aiinput.example.json (Join-Path $configDir "aiinput.json")
codex-watchdog --plugin aiinput
```

State that the model status URL is fixed at `https://status.input.im/api/status` and balances use
one authenticated `https://ai.input.im/v1/usage` request per configured API key.

- [ ] **Step 7: Run focused and complete checks**

Run:

```bash
node --test test/aiinput-plugin.test.mjs test/plugin-loader.test.mjs test/balance-adapters.test.mjs
npm test
npm run check
git diff --check
```

Expected: all commands exit 0; the complete suite has 126 tests after adding the 3 plugin tests.

- [ ] **Step 8: Commit configuration and documentation**

```bash
git add plugins/aiinput.example.json test/aiinput-plugin.test.mjs docs/plugins/README.md
git commit -m "docs: add aiinput plugin setup"
```

### Task 3: Installed and live verification

**Files:**
- No source changes expected

- [ ] **Step 1: Verify the installed CLI package**

Run:

```bash
npm run test:cli
```

Expected: exit 0 and `installed codex-watchdog command forwarded cwd and arguments correctly`.

- [ ] **Step 2: Verify the real app-server protocol**

Run:

```bash
npm run test:live
```

Expected: exit 0 and `live app-server websocket, turn/interrupt, and compact smoke passed`.

- [ ] **Step 3: Inspect final repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline -6
```

Expected: no whitespace errors, a clean worktree, and the two ai.input.im implementation commits at
the top of the log.
