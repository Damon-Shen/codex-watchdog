# Codex Watchdog

Codex Watchdog 是一个面向长时间 Codex 任务的本地故障恢复启动器。它不修改 Codex，
而是在 Codex TUI 与实验性 `app-server` 之间运行一个仅监听本机回环地址的 WebSocket
代理：识别可恢复故障、复核最新任务状态，并在安全条件满足后继续 goal、普通 thread 或
子代理工作流。

项目同时提供可扩展的中转站插件运行时。每个站点可以独立定义模型测活解析；余额查询可
复用 Sub2API、New API 适配器，也可以由插件完全自定义。仓库内附带可直接使用的
ai.input.im 插件和多订阅配置示例。

> Codex `app-server` 仍是实验接口。Codex 升级后应重新运行 live smoke test，并在用于
> 长时间无人值守任务前进行一次受监督的真实恢复验证。

## 核心特性

- 识别结构化的 429、502、503、504、连接中断、服务过载和模型容量错误。
- 给 Codex 自带重试保留宽限期；同一 turn 恢复进展后取消待执行的主动中断。
- 在重试停滞后最多中断当前 turn 一次，并在最终状态复核后继续任务。
- 支持 blocked goal、普通 thread、上下文压缩恢复和子代理父线程路由。
- 一个中转站对应一个命名插件，无需把站点解析逻辑写入 watchdog 核心。
- 支持多个 API key 独立查余额，并按 `any`、`all` 或 `sum` 策略聚合。
- 插件 HTTP 请求具备超时、取消、生命周期管理和 API key 日志脱敏。
- 未启用插件时保持原有本地恢复行为。

watchdog 不会绕过人工暂停、认证失败、明确的余额不足、token budget、永久错误或已经
完成的任务。

## 环境要求

- Node.js 22 或更高版本。
- 通过 npm 全局安装的 OpenAI Codex CLI。
- macOS、Linux 或 Windows；Windows 另提供 PowerShell 和 CMD 启动脚本。

启动器优先读取 `CODEX_WATCHDOG_CODEX_JS`。未设置时通过 `npm root --global` 查找
`@openai/codex/bin/codex.js`，Windows 下还会兼容 `%APPDATA%\npm\node_modules`。

## 安装

普通用户克隆仓库并安装全局命令：

```bash
git clone https://github.com/Damon-Shen/codex-watchdog.git
cd codex-watchdog
npm ci
npm install -g .
```

开发者可以让全局命令直接指向当前工作区：

```bash
npm ci
npm link
```

项目不会发布 npm 包；以上命令只在本机注册 `codex-watchdog`。

## 快速开始

在需要运行 Codex 的项目目录执行：

```bash
codex-watchdog
```

明确指定工作目录或继续传递普通 Codex 参数：

```bash
codex-watchdog -C /path/to/project
codex-watchdog resume
codex-watchdog resume --all
```

未传 `-C` 或 `--cd` 时，watchdog 会把当前目录显式传给 Codex，确保 `resume` 仍按当前
工作区筛选会话。

Windows PowerShell 和 CMD 也可以直接使用仓库脚本：

```powershell
& "C:\tools\codex-watchdog\bin\codex-watchdog.ps1" -C "C:\work\repo"
```

```bat
C:\tools\codex-watchdog\bin\codex-watchdog.cmd -C C:\work\repo
```

不要手动传入 `--remote`。代理地址由 watchdog 创建；额外的 `--remote` 会绕过恢复链，
启动器会直接拒绝。

## ai.input.im 快速配置

ai.input.im 是仓库附带的站点插件示例。插件负责解析站点模型状态；watchdog 核心使用
内置 Sub2API 适配器查询多个订阅余额。

POSIX 系统：

```bash
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-watchdog/plugins"
mkdir -p "$config_dir"
cp plugins/aiinput.mjs "$config_dir/aiinput.mjs"
cp plugins/aiinput.example.json "$config_dir/aiinput.json"
chmod 600 "$config_dir/aiinput.json"
```

Windows PowerShell：

```powershell
$configDir = Join-Path $env:APPDATA "codex-watchdog\plugins"
New-Item -ItemType Directory -Force $configDir | Out-Null
Copy-Item plugins\aiinput.mjs (Join-Path $configDir "aiinput.mjs")
Copy-Item plugins\aiinput.example.json (Join-Path $configDir "aiinput.json")
```

启动前编辑 `aiinput.json`：

- 将每个 `apiKeys[].value` 替换为真实 API key。
- 按订阅修改账户 `id`，需要时增加或删除 key 记录。
- 将 `model` 改为实际使用的模型名称。
- 设置 `balancePolicy.mode` 和 `balancePolicy.minimum`；阈值为 `0` 时无法识别零余额不足。

然后启动：

```bash
codex-watchdog --plugin aiinput
```

ai.input.im 插件使用两个固定接口：

- `GET https://ai.input.im/v1/usage`：为每个配置的 API key 查询余额。
- `GET https://status.input.im/api/status`：精确读取配置模型的可用状态。

完整字段、目录规则和插件开发接口见[中转站插件指南](docs/plugins/README.md)。

## 恢复决策

```text
Codex TUI -> watchdog WebSocket proxy -> Codex app-server -> provider
```

| 故障或状态 | 余额检查 | 后续动作 |
|---|---|---|
| 插件模式下的 HTTP 429 | 查询全部账户并聚合 | `insufficient` 停止；`available` 或 `unknown` 进入模型测活 |
| 502、503、504、连接中断、过载、模型容量 | 跳过 | 直接进入模型测活 |
| 上下文窗口耗尽 | 跳过 | 压缩原 thread，完成后恢复 |
| 人工暂停、认证或永久错误 | 跳过 | 不自动恢复 |

模型探针只在站点明确给出结果时返回 `true` 或 `false`。HTTP 错误、超时、取消、格式异常
或无法找到模型都属于 `unknown`。恢复确认需要观察到 `false -> true`，或者得到间隔至少
一个探测周期的连续两个 `true`。

项目不维护连续 429 次数，也没有“余额健康但连续 429”的熔断器。余额接口明确不足时
停止；余额可用或未知时，由模型测活决定何时进入最终状态复核。

恢复动作前，控制器会重新读取当前 thread 或 goal 状态：

- blocked goal 通过 `thread/goal/set` 恢复为 `active`。
- 长时间重试的 turn 可以先执行一次 `turn/interrupt`，再恢复原 goal。
- 没有 goal 的普通 thread 使用 `turn/start` 发送谨慎的继续提示。
- 子代理不能直接接收输入时，使用 `turn/steer` 或 `turn/start` 路由给可输入的父 thread。
- 上下文耗尽通过 `thread/compact/start` 压缩原 thread 后再恢复。

协议取舍和状态边界见
[ADR-0001](docs/adr/0001-app-server-transient-goal-recovery.md)。

## 中转站插件

一个中转站对应一个插件和同名 JSON 配置：

```bash
codex-watchdog --plugin relay-name
```

配置从用户目录自动加载，不从当前项目目录读取：

```text
Linux/macOS: $XDG_CONFIG_HOME/codex-watchdog/plugins/relay-name.json
             未设置 XDG_CONFIG_HOME 时使用 ~/.config/codex-watchdog/plugins/relay-name.json
Windows:     %APPDATA%\codex-watchdog\plugins\relay-name.json
```

核心与插件的职责边界：

| 组件 | 职责 |
|---|---|
| watchdog 核心 | 错误分类、Sub2API/New API 余额查询、多账户聚合、超时、取消、脱敏、恢复确认和 Codex RPC |
| 站点插件 | 站点状态 URL、请求格式、模型匹配、响应解析，以及 `custom` 技术栈的特殊余额解析 |

插件默认导出工厂，并至少实现 `checkModel`：

```js
export default function createPlugin({ config, host }) {
  return {
    apiVersion: 1,
    id: "relay-name",

    async checkModel({ signal }) {
      const response = await host.http.request({
        url: "https://relay.example/status",
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      const status = payload?.models?.[config.model]?.status;
      if (status === "online") return true;
      if (status === "offline") return false;
      throw new Error(`Unknown status for ${config.model}`);
    },
  };
}
```

其他网站即使探针 URL 和返回格式完全不同，也只需编写新的站点插件。使用 `sub2api` 或
`newapi` 时通常无需实现余额查询；其他格式使用 `stack: "custom"` 并实现
`checkBalances`。完整契约和示例见[插件开发文档](docs/plugins/README.md)。

## 配置

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `CODEX_WATCHDOG_CODEX_JS` | 指定 Codex 的 `codex.js` 入口 | 自动查找全局 npm 安装 |
| `CODEX_WATCHDOG_DELAYS_MS` | 逗号分隔的恢复退避时间，单位毫秒 | `30000,60000,120000,300000` |
| `CODEX_WATCHDOG_INTERRUPT_AFTER_MS` | Codex 持续重试多久后允许中断当前 turn | `120000` |

临时缩短恢复时间进行测试：

```bash
CODEX_WATCHDOG_DELAYS_MS="1000,2000,5000" \
CODEX_WATCHDOG_INTERRUPT_AFTER_MS="10000" \
codex-watchdog --plugin aiinput
```

## 日志与安全边界

- watchdog 只监听 `127.0.0.1`，不提供远程服务，也不接管 Codex 认证。
- 日志写入 `logs/watchdog-YYYY-MM-DD.log`，该目录不会进入 Git。
- 配置中的 API key 会在插件 host 日志和加载错误中替换为 `[REDACTED]`。
- 插件是受信任的进程内 Node.js 代码，不是安全沙箱；只安装可信插件。
- API key 应只保存在用户配置目录，并在 POSIX 系统限制 JSON 文件权限。
- 自动恢复可能重试已经产生外部副作用的任务；无人值守任务仍需能够安全重试。

## 验证

运行完整单元测试、代理集成测试和语法检查：

```bash
npm test
npm run check
```

验证打包后的 CLI 参数转发：

```bash
npm run test:cli
```

Codex 安装或升级后，运行真实 `app-server` 协议 smoke test：

```bash
npm run test:live
```

live test 会验证 WebSocket 初始化、`turn/interrupt` 和 `thread/compact/start`。它不会
制造真实 provider 故障，也不能单独证明所有未来 Codex 版本兼容。

## 项目结构

```text
bin/             Node.js、PowerShell 和 CMD 启动入口
src/             启动器、代理、恢复控制器、插件 host 和余额适配器
plugins/         仓库附带的站点插件与脱敏配置示例
test/            单元测试、代理集成测试和 live smoke test
docs/adr/        架构决策记录
docs/plugins/    插件安装、配置与开发指南
```

## 作者与鸣谢

- 原作者：[flowing-water1](https://github.com/flowing-water1)
- 社区鸣谢：[Linux.do](https://linux.do)

## 许可证

本项目使用 [MIT License](LICENSE)。版权归属保留为：

```text
Copyright (c) 2026 flowing-water1
```
