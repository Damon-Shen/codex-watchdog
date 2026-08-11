# 中转站插件

一个插件对应一个具体中转站。配置声明站点技术栈、余额查询域名、一个或多个 API key、
模型和探测间隔；插件代码实现该站点的模型测活，并可覆盖余额解析。

## 启动

watchdog 只接受一个插件选择参数：

```bash
codex-watchdog --plugin relay-name
```

`--plugin` 不会传给 Codex。未传该参数时不加载插件；显式选择的插件无法加载时，watchdog
会在分配端口和启动 Codex 子进程前退出。

同名配置文件的位置如下：

```text
Linux/macOS: $XDG_CONFIG_HOME/codex-watchdog/plugins/relay-name.json
             未设置 XDG_CONFIG_HOME 时使用
             ~/.config/codex-watchdog/plugins/relay-name.json

Windows:     %APPDATA%\codex-watchdog\plugins\relay-name.json
```

配置不会从当前项目目录读取，避免 API key 被误提交。POSIX 系统建议限制权限：

```bash
chmod 600 ~/.config/codex-watchdog/plugins/relay-name.json
```

## 配置

完整结构可参考 [example-plugin.json](example-plugin.json)：

```json
{
  "apiVersion": 1,
  "module": "@vendor/codex-watchdog-relay",
  "stack": "sub2api",
  "baseUrl": "https://relay.example.com",
  "apiKeys": [
    { "id": "subscription-a", "value": "secret-a" },
    { "id": "subscription-b", "value": "secret-b" }
  ],
  "model": "gpt-5.6-sol",
  "probeIntervalMs": 30000,
  "requestTimeoutMs": 4000,
  "balancePolicy": { "mode": "any", "minimum": 1 },
  "options": {}
}
```

- `module` 可以是 npm 包，也可以是相对 JSON 文件的本地 ESM 路径。
- `stack` 支持 `sub2api`、`newapi` 和 `custom`。
- `sub2api` 内置查询 `GET /v1/usage`，余额和阈值使用美元。
- `newapi` 内置查询 `GET /api/usage/token/`，余额和阈值使用 New API 原生额度单位。
- `apiKeys` 必须包含唯一 `id` 和实际 key；每个 key 会独立查询。
- `probeIntervalMs` 是模型恢复确认的采样间隔，不是常驻轮询周期。
- `requestTimeoutMs` 是单次插件 HTTP 请求超时。
- `options` 完全由站点插件解释。

多账户聚合策略：

- `any`：任一已知余额达到 `minimum` 即可用；全部已知且都不足才是不足。
- `all`：全部账户达到阈值才可用；任一已知账户不足即为不足。
- `sum`：已知余额合计达到阈值即可用；只有全部查询成功且合计不足才是不足。

查询失败使用 `unknown`，不会被当成零余额。

## ai.input.im

仓库内的 `plugins/aiinput.mjs` 和 `plugins/aiinput.example.json` 可以直接复制到用户配置
目录。POSIX 系统执行：

```bash
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-watchdog/plugins"
mkdir -p "$config_dir"
cp plugins/aiinput.mjs "$config_dir/aiinput.mjs"
cp plugins/aiinput.example.json "$config_dir/aiinput.json"
chmod 600 "$config_dir/aiinput.json"
codex-watchdog --plugin aiinput
```

Windows PowerShell 执行：

```powershell
$configDir = Join-Path $env:APPDATA "codex-watchdog\plugins"
New-Item -ItemType Directory -Force $configDir | Out-Null
Copy-Item plugins\aiinput.mjs (Join-Path $configDir "aiinput.mjs")
Copy-Item plugins\aiinput.example.json (Join-Path $configDir "aiinput.json")
codex-watchdog --plugin aiinput
```

启动前编辑 `aiinput.json`：替换 `model`、每个 `apiKeys[].value`、账户 `id` 和
`balancePolicy.minimum`；有更多订阅时可继续添加 key 记录。模型测活地址固定为
`https://status.input.im/api/status`。余额由内置 Sub2API 适配器为每个配置的 API key
分别请求一次 `https://ai.input.im/v1/usage`。

## 安装模块

本地私有插件可将 `module` 写成 `./relay.mjs`，并把文件放在 JSON 旁边。npm 插件可以安装
到用户配置根目录，Node.js 会从配置文件位置向上解析 `node_modules`。

POSIX 示例：

```bash
npm install --prefix ~/.config/codex-watchdog @vendor/codex-watchdog-relay
```

PowerShell 示例：

```powershell
npm install --prefix "$env:APPDATA\codex-watchdog" @vendor/codex-watchdog-relay
```

## 插件接口

模块默认导出工厂函数：

```js
export default function createPlugin({ config, host }) {
  return {
    apiVersion: 1,
    async checkModel({ signal }) {
      // 必须返回严格的 true 或 false。
    },
    async checkBalances({ signal }) {
      // 可选；custom 技术栈必须实现。
    },
    async close() {},
  };
}
```

正式的 host 能力只有：

- `host.http.request(...)`：带超时、取消和脱敏错误日志的 HTTP 请求。
- `host.balanceAdapters.sub2api(...)` 和 `host.balanceAdapters.newapi(...)`。
- `host.logger.info/warn/error(...)`：配置的 API key 会被替换为 `[REDACTED]`。
- `host.signal`：插件运行时生命周期信号。

插件不能获得 Codex RPC、控制器或 thread 状态，也不应自行创建探测定时器。完整自定义实现见
[example-plugin.mjs](example-plugin.mjs)。

`checkModel` 的 `true` 表示本次指定模型可用，`false` 表示不可用；抛错、超时和非布尔值
是未知。一次恢复周期在观察到 `false -> true` 时确认恢复；如果从未观察到 `false`，需要
间隔至少 `probeIntervalMs` 的连续两个 `true`。未知结果会打断连续 `true`。

自定义 `checkBalances` 返回每个配置账户的结果：

```js
[
  { accountId: "subscription-a", balance: 12.5 },
  { accountId: "subscription-b", balance: null }
]
```

账户必须完整且不能重复。`null` 表示未知；负数、非有限数和缺失账户是插件契约错误。

## 429 恢复规则

插件模式对所有 HTTP 429 先查询并聚合余额，不依赖错误文案判断原因：

```text
429 -> insufficient -> 停止本轮恢复
429 -> available    -> 模型测活 -> 核心状态复核 -> 恢复 Codex
429 -> unknown      -> 模型测活 -> 核心状态复核 -> 恢复 Codex
```

502、503、504、连接中断、服务过载和模型容量错误跳过余额查询，直接进入模型测活。上下文
耗尽仍由 watchdog 执行压缩恢复，不经过站点插件。

watchdog 不维护连续 429 次数，也没有“余额健康但连续 429”的熔断器。如果站点限制没有
反映在余额接口中，可能发生重复恢复。这是以余额和模型结果作为唯一站点门禁的明确取舍。

## 信任与副作用

插件在 watchdog 进程内运行，拥有普通 Node.js 代码的权限，不提供恶意代码沙箱。只安装
可信插件，并像保护凭据一样保护 JSON 配置。

插件只报告站点状态，恢复动作始终由核心在重新读取 thread/goal 状态后执行。即便如此，
继续失败任务仍可能重复已经完成的外部副作用；任务本身需要能够安全重试。
