# Relay Plugin Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace the hard-coded ai.input.im recovery probe with an explicitly selected, independently distributable per-relay plugin while preserving watchdog's core recovery state machine.

**Architecture:** The launcher consumes --plugin <name>, loads a same-name user configuration, and dynamically imports the configured npm package or local ESM module. A plugin exposes model health probing and optional normalized balance checks; the host owns HTTP lifecycle, polling, cancellation, and all Codex RPC recovery actions. Existing no-plugin behavior remains unchanged.

**Tech Stack:** Node.js 22 ESM, native fetch/AbortController, existing ws WebSocket proxy, Node test runner, JSON configuration.

---

### Task 1: Plugin configuration and launcher boundary

**Files:**
- Create: src/plugin-loader.mjs
- Modify: src/launcher-support.mjs
- Test: test/plugin-loader.test.mjs, test/launcher-support.test.mjs

- [ ] **Step 1: Write failing tests**

Cover POSIX XDG and Windows APPDATA config paths, rejection of ../relay, loading a local module,
missing config, duplicate/missing --plugin, and preserving arguments after --.

~~~js
test("rejects a path-like plugin name", () => {
  assert.throws(() => validatePluginName("../relay"), /plugin name/);
});
test("consumes only the watchdog plugin flag", () => {
  assert.deepEqual(extractWatchdogArgs(["--plugin", "relay", "resume"]), {
    pluginName: "relay",
    forwardedArgs: ["resume"],
  });
});
~~~

- [ ] **Step 2: Run focused tests and verify failure**

Run: node --test test/plugin-loader.test.mjs test/launcher-support.test.mjs

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement the resolver**

Export validatePluginName, resolvePluginConfigPath, and loadPlugin. Resolve
$XDG_CONFIG_HOME/codex-watchdog/plugins/<name>.json (or ~/.config) on POSIX and
%APPDATA%/codex-watchdog/plugins/<name>.json on Windows. Parse JSON and require config apiVersion
1. Resolve relative module values from the config directory and npm specifiers with
createRequire(configPath). Call the module's default factory with { config, host }; reject missing
factory, missing checkModel, and plugin API versions other than 1.

- [ ] **Step 4: Implement argument consumption**

Add extractWatchdogArgs(args) to consume one --plugin name, reject duplicates/missing values, and
leave arguments after -- untouched. Keep launcher wiring for Task 6, after the host and recovery gate
interfaces exist; the no-plugin path must remain unchanged.

- [ ] **Step 5: Run and commit**

Run: node --test test/plugin-loader.test.mjs test/launcher-support.test.mjs

Expected: PASS. Commit:

~~~bash
git add src/plugin-loader.mjs src/launcher-support.mjs test/plugin-loader.test.mjs test/launcher-support.test.mjs
git commit -m "feat: load named relay plugins"
~~~

### Task 2: Host HTTP API and balance policies

**Files:**
- Create: src/plugin-host.mjs, src/balance.mjs
- Test: test/plugin-host.test.mjs, test/balance.test.mjs

- [ ] **Step 1: Write failing HTTP host tests**

Test timeout, caller cancellation, response readers, non-2xx errors, and redaction of authorization
headers and configured API key values from warnings.

- [ ] **Step 2: Implement the host**

Export createPluginHost({ config, fetchImpl, logger }). Its
host.http.request({ url, method = "GET", headers, body, signal, timeoutMs }) requires an absolute
URL, combines caller and timeout signals with AbortSignal.any, and returns
{ status, ok, headers, json, text }. Expose redacted info/warn/error logging and balance adapter
slots without exposing Codex RPC.

- [ ] **Step 3: Write failing aggregation tests**

Assert these results and also cover invalid policy, empty accounts, duplicate IDs, negative values,
and non-finite values:

~~~js
assert.equal(aggregateBalances([{ balance: 2 }, { balance: 0 }], { mode: "any", minimum: 1 }), "available");
assert.equal(aggregateBalances([{ balance: 0 }, { balance: 0 }], { mode: "any", minimum: 1 }), "insufficient");
assert.equal(aggregateBalances([{ balance: 0 }, { balance: null }], { mode: "any", minimum: 1 }), "unknown");
assert.equal(aggregateBalances([{ balance: 2 }, { balance: 3 }], { mode: "sum", minimum: 4 }), "available");
~~~

- [ ] **Step 4: Implement three-state aggregation**

Export validateBalancePolicy, normalizeBalances, and aggregateBalances. Implement any available
when one account reaches the threshold and insufficient only when all successful accounts are below
it; all available only when all reach it and insufficient when any known account is below it; sum
available when known total reaches the threshold and insufficient only when all accounts succeeded
and total is below it. Unknown data never becomes zero.

- [ ] **Step 5: Run and commit**

Run: node --test test/plugin-host.test.mjs test/balance.test.mjs

Expected: PASS. Commit:

~~~bash
git add src/plugin-host.mjs src/balance.mjs test/plugin-host.test.mjs test/balance.test.mjs
git commit -m "feat: add plugin host and balance policies"
~~~

### Task 3: Generic model recovery gate

**Files:**
- Create: src/model-recovery-gate.mjs
- Test: test/model-recovery-gate.test.mjs

- [ ] **Step 1: Write failing lifecycle tests**

Test immediate first sample, delayed second true, false -> true, true -> unknown -> true -> true,
superseding-cycle cancellation, timeout, close rejection, late callbacks, and no concurrent checks.

- [ ] **Step 2: Implement the gate**

Export ModelRecoveryGate with constructor({ checkModel, intervalMs, schedule, cancel, logger }),
beginRecoveryCheck(context), waitForRecovery(), and close(). Maintain one cycle counter, one timer,
one active request, and waiter settlement. Strict booleans are samples; every other result is unknown.
The gate must contain no Codex-specific logic.

- [ ] **Step 3: Run and commit**

Run: node --test test/model-recovery-gate.test.mjs

Expected: PASS. Commit:

~~~bash
git add src/model-recovery-gate.mjs test/model-recovery-gate.test.mjs
git commit -m "feat: add generic model recovery gate"
~~~

### Task 4: Built-in balance adapters

**Files:**
- Create: src/balance-adapters.mjs
- Modify: src/plugin-loader.mjs, src/plugin-host.mjs
- Test: test/balance-adapters.test.mjs, test/plugin-loader.test.mjs

- [ ] **Step 1: Write adapter tests**

Use representative sub2api/newapi responses to verify base URL construction, one request per API
Key, authorization headers, account IDs, numeric balances, malformed responses, and non-2xx/unknown
balances.

- [ ] **Step 2: Implement adapters and selection**

Export querySub2ApiBalances({ config, http, signal }), queryNewApiBalances({ config, http, signal }),
and selectBalanceAdapter(stack). Keep all stack-specific paths, headers, and response extraction in
this module. A plugin checkBalances overrides a built-in adapter; stack custom requires the override.

- [ ] **Step 3: Assemble the runtime**

Make the loader create the host and select a normalized balance function:

~~~js
const queryBalances = plugin.checkBalances
  ?? ((context) => selectBalanceAdapter(config.stack)(context));
const checkBalances = async (context) => aggregateBalances(
  await queryBalances(context),
  config.balancePolicy,
);
~~~

Validate model, positive interval/timeout, policy, and the selected balance path before app-server
startup. Return a runtime object containing the plugin, host, normalized checkBalances, and a
ModelRecoveryGate constructed with plugin.checkModel.

- [ ] **Step 4: Run and commit**

Run: node --test test/balance-adapters.test.mjs test/plugin-loader.test.mjs

Expected: PASS. Commit:

~~~bash
git add src/balance-adapters.mjs src/plugin-loader.mjs src/plugin-host.mjs test/balance-adapters.test.mjs test/plugin-loader.test.mjs
git commit -m "feat: add relay balance adapters"
~~~

### Task 5: Controller and proxy integration

**Files:**
- Modify: src/controller.mjs, src/policy.mjs, src/proxy.mjs
- Test: test/controller.test.mjs, test/proxy.integration.test.mjs

- [ ] **Step 1: Write failing controller tests**

Extend the existing harness with recoveryGate and checkBalances. Assert:
429 -> insufficient performs no model check or recovery RPC; 429 -> available/unknown enters the
gate; 503/connection errors skip balance checks; model-capacity errors enter the gate; context
exhaustion stays on compaction; manual pause/new turn/parent routing still cancel or route recovery.

- [ ] **Step 2: Add optional controller dependencies**

Extend the constructor with:

~~~js
constructor({ sendRequest, recoveryGate = null, checkBalances = null, ...options }) {}
~~~

For a 429, await checkBalances({ error, signal }); stop only for insufficient. For available/unknown
and every other supported transient error, call recoveryGate.beginRecoveryCheck({ error,
balanceStatus }) and await waitForRecovery() inside the existing correlated timer. Re-check
thread/goal state before RPCs. Never add a consecutive-429 counter. With no gate, preserve the
existing scheduler.

- [ ] **Step 3: Keep policy generic and pass dependencies through proxy**

Do not add relay-specific strings to policy.mjs; retain generic transient, terminal, context, and
model-capacity categories. Extend createWatchdogProxy to receive the gate and balance checker,
construct one controller per session, and cancel/reject plugin work on session close.

- [ ] **Step 4: Run and commit**

Run: node --test test/controller.test.mjs test/proxy.integration.test.mjs

Expected: existing and new integration tests pass. Commit:

~~~bash
git add src/controller.mjs src/policy.mjs src/proxy.mjs test/controller.test.mjs test/proxy.integration.test.mjs
git commit -m "feat: gate recovery through relay plugins"
~~~

### Task 6: CLI lifecycle, checks, and compatibility

**Files:**
- Modify: src/launcher.mjs, bin/codex-watchdog.mjs, package.json
- Test: test/installed-cli.mjs, test/launcher-support.test.mjs

- [ ] **Step 1: Add CLI tests**

Verify --plugin relay is consumed, forwarded Codex arguments are unchanged, missing config exits
before app-server spawn, and no-plugin invocation produces the prior argument list.

- [ ] **Step 2: Implement lifecycle ordering**

Load/validate the plugin and create one host/gate per launcher process before ports or child
processes. Pass the gate and normalized checkBalances to createWatchdogProxy. In finally, close proxy
first, then gate/plugin, then TUI and app-server; preserve existing SIGINT/SIGTERM exit codes.

- [ ] **Step 3: Update checks and run**

Add new source files to npm run check, then run:
npm run check && node --test test/installed-cli.mjs test/launcher-support.test.mjs

Expected: PASS. Commit:

~~~bash
git add src/launcher.mjs bin/codex-watchdog.mjs package.json test/installed-cli.mjs test/launcher-support.test.mjs
git commit -m "feat: expose named plugin launcher option"
~~~

### Task 7: Documentation and extension example

**Files:**
- Modify: README.md
- Create: docs/plugins/README.md, docs/plugins/example-plugin.mjs, docs/plugins/example-plugin.json

- [ ] **Step 1: Document installation and configuration**

Document user config paths, npm installation into the user plugin root, relative local modules,
codex-watchdog --plugin <name>, multiple keys, and API Key file permissions.

- [ ] **Step 2: Add a complete example**

The example must use host.http.request, return strict booleans from checkModel, show a multi-key
balance policy, and demonstrate a custom checkBalances override without creating timers or calling
Codex RPC.

- [ ] **Step 3: Document limitations**

State the 429 balance flow, unknown semantics, two-sample model confirmation, absence of a healthy-429
breaker, trusted in-process execution, and duplicate side-effect risk.

- [ ] **Step 4: Run and commit**

Run: npm test && npm run check

Expected: PASS. Commit:

~~~bash
git add README.md docs/plugins
git commit -m "docs: explain relay plugin development"
~~~

### Task 8: End-to-end verification

**Files:**
- Modify: test/proxy.integration.test.mjs for the final plugin fixture
- Modify: docs/adr/0001-app-server-transient-goal-recovery.md with a dated amendment

- [ ] **Step 1: Run the complete suite**

Run: npm test && npm run check && npm run test:cli

Expected: all tests pass and the CLI smoke test exits successfully.

- [ ] **Step 2: Run the live protocol smoke test**

Run: npm run test:live

Expected: WebSocket initialization, turn/interrupt, and thread/compact/start checks pass; this
remains plugin-free.

- [ ] **Step 3: Perform local-plugin smoke verification**

Use a temporary user config and local plugin whose model check returns false once then true twice.
Verify recovery waits for the confirmed sequence and logs never contain config secrets.

- [ ] **Step 4: Record evidence and review**

Run git diff --check, git status --short, and git log --oneline -8. Add test counts, live-smoke
result, and any protocol caveat to the ADR amendment. Commit the amendment separately.
