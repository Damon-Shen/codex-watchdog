# Codex Watchdog 中转站插件模式设计

日期：2026-08-10

## 背景

现有 `ai.input.im` 适配把站点状态接口、响应解析、余额判断和模型恢复确认直接接入
watchdog。这个实现能解决单个中转站的恢复问题，但每增加一个站点都需要修改并重新发布
watchdog，破坏了项目作为通用恢复启动器的边界。

本设计将中转站特有能力移入站点插件。一个插件对应一个具体中转站；插件声明站点使用的
技术栈、余额查询配置和模型测活实现。watchdog 继续独占 Codex 状态机、恢复动作和并发
安全控制。

## 目标

- 每个中转站能够独立开发、测试和发布适配，不要求发布新版 watchdog。
- 同时支持 npm 包和本地 ESM 文件，满足公开分发与私有调试场景。
- 通过唯一的 `--plugin <name>` 参数选择站点插件和同名配置。
- 支持 `sub2api`、`newapi` 的内置余额查询，以及自定义技术栈覆盖。
- 一个站点可配置多个余额查询 API Key，并通过可配置策略聚合。
- 站点可以实现任意模型测活流程，但最终只向主程序返回布尔状态。
- 插件不能直接操作 Codex RPC；主程序收到恢复结果后继续 goal、普通 thread 或父 thread。
- 未启用插件时保持现有 watchdog 行为。

## 非目标

- 不为插件提供恶意代码安全沙箱。加载插件等同于执行受信任的 npm 包或本地脚本。
- 第一版不允许一个 watchdog 进程同时组合多个站点插件。
- 不自动识别当前中转站，也不根据 Codex 上游 URL 猜测插件。
- 不由插件接管认证失败、人工暂停、上下文压缩或 Codex 的恢复状态机。
- 不为连续健康 `429` 增加额外熔断；恢复由余额判断和模型测活结果决定。

## 插件发现与配置

### 命令行入口

用户仅需传入逻辑名称：

```bash
codex-watchdog --plugin aiinput
```

`--plugin` 由 watchdog 启动器消费，不转发给 Codex。插件名只能包含字母、数字、点、
下划线和连字符，不允许路径分隔符或路径跳转片段。

未传 `--plugin` 时不加载插件。显式选择的插件无法加载或初始化时，watchdog 拒绝启动，
不静默降级到无插件模式。

### 配置位置

watchdog 按插件名从用户配置目录加载 JSON：

```text
Linux/macOS: $XDG_CONFIG_HOME/codex-watchdog/plugins/<name>.json
             未设置 XDG_CONFIG_HOME 时使用 ~/.config/codex-watchdog/plugins/<name>.json

Windows:     %APPDATA%\codex-watchdog\plugins\<name>.json
```

第一版不从当前项目目录加载插件配置，避免 API Key 被误提交到仓库。

### 配置结构

```json
{
  "apiVersion": 1,
  "module": "@vendor/codex-watchdog-aiinput",
  "stack": "sub2api",
  "baseUrl": "https://relay.example.com",
  "apiKeys": [
    { "id": "subscription-a", "value": "secret-a" },
    { "id": "subscription-b", "value": "secret-b" }
  ],
  "model": "gpt-5.6-sol",
  "probeIntervalMs": 30000,
  "requestTimeoutMs": 4000,
  "balancePolicy": {
    "mode": "any",
    "minimum": 1
  },
  "options": {}
}
```

字段语义：

- `apiVersion`：配置格式主版本，第一版固定为 `1`。
- `module`：npm 包名或本地 ESM 路径。本地相对路径以当前 JSON 所在目录为基准。
- `stack`：`sub2api`、`newapi` 或 `custom`。
- `baseUrl`：余额接口所属站点的基础域名。
- `apiKeys`：一个或多个余额查询凭据；`id` 用于脱敏日志，`value` 不得写入日志。
- `model`：模型测活针对的精确模型名。
- `probeIntervalMs`：模型确认采样间隔，必须大于零。
- `requestTimeoutMs`：单次 HTTP 请求超时，必须大于零。
- `balancePolicy`：多账户余额聚合策略。
- `options`：站点私有配置，由插件解释，watchdog 核心不读取其字段。

npm 包使用 Node 模块解析规则、以配置文件所在目录为解析基准。用户可将依赖安装到用户
配置根目录的 `node_modules`。本地模块无需发布，适合私有站点和开发调试。

## 信任与运行边界

插件是受信任的进程内 ESM 代码。它事实上可以访问 Node.js 进程能力；项目文档必须明确
说明安装插件等同于运行对应代码。主程序提供的 HTTP 客户端是正式 API、生命周期和测试
边界，而不是恶意代码隔离机制。

一个 watchdog 进程只加载一个活动插件。插件可以读取自己的配置和调用主程序公开能力，
但不能获得 Codex RPC 发送函数、控制器实例或内部 thread 状态。

## 插件接口

插件模块默认导出工厂函数：

```js
export default function createPlugin({ config, host }) {
  return {
    apiVersion: 1,
    id: "aiinput",

    async checkModel({ signal }) {
      const response = await host.http.request({
        url: "https://status.example.com/model",
        signal,
      });
      const payload = await response.json();
      return payload.services.some(
        (service) => service.model === config.model && service.available === true,
      );
    },

    async checkBalances({ signal }) {
      return [
        { accountId: "subscription-a", balance: 12.5 },
        { accountId: "subscription-b", balance: null },
      ];
    },

    close() {},
  };
}
```

### 主程序能力

`host` 提供以下稳定能力：

- `host.http.request(...)`：统一请求超时、取消、错误包装和响应读取。
- `host.balanceAdapters.sub2api(...)`：内置 sub2api 余额查询。
- `host.balanceAdapters.newapi(...)`：内置 newapi 余额查询。
- 脱敏日志接口。
- 当前插件生命周期的 `AbortSignal`。

插件不得自行创建探测定时器。轮询间隔、并发限制、恢复周期和关闭取消均由主程序管理。

### `checkModel`

`checkModel` 是必需方法。它可以通过 `host.http` 发出一个或多个请求，必须最终返回严格的
`true` 或 `false`：

- `true`：指定模型本次测活可用。
- `false`：指定模型本次测活不可用。
- 抛错、超时或非布尔结果：由主程序归一化为 `unknown`。

### `checkBalances`

`checkBalances` 是可选方法。它在任何技术栈下都可以覆盖内置余额查询；当
`stack: "custom"` 时必须实现。返回值是每个账户的标准化余额：

```js
[
  { accountId: "subscription-a", balance: 12.5 },
  { accountId: "subscription-b", balance: null }
]
```

数值余额必须使用同一站点和配置约定的单位。`null` 表示未知，不能用零表示查询失败。
当插件没有覆盖该方法时，主程序根据 `stack` 调用内置 `sub2api` 或 `newapi` 适配器。

### 关闭

`close()` 是可选方法。watchdog 退出时先取消探测定时器和在途 HTTP 请求，再调用它。
新恢复周期开始时，旧周期的在途请求和回调也必须失效。

## 余额聚合

主程序将余额列表归一化为 `available`、`insufficient` 或 `unknown`。

### `any`

- 任一已知余额大于等于 `minimum`：`available`。
- 所有账户都成功查询且全部低于 `minimum`：`insufficient`。
- 没有账户达到阈值且至少一个账户未知：`unknown`。

### `all`

- 所有账户都成功查询且全部大于等于 `minimum`：`available`。
- 任一已知账户低于 `minimum`：`insufficient`。
- 没有已知不足，但至少一个账户未知：`unknown`。

### `sum`

- 已知余额之和已经大于等于 `minimum`：`available`。
- 所有账户都成功查询且总和低于 `minimum`：`insufficient`。
- 已知总和低于阈值且至少一个账户未知：`unknown`。

空 `apiKeys`、重复账户 ID、非有限余额或负阈值属于配置或插件契约错误，不能被解释为余额
不足。

## 错误触发与恢复数据流

核心继续负责通用错误分类。插件不提供站点错误分类器。

```text
Codex 可恢复错误
  |
  +-- 429
  |     |
  |     +-- 查询并聚合全部余额
  |             |
  |             +-- insufficient --> 停止本轮自动恢复
  |             +-- available -----> 模型测活
  |             +-- unknown --------> 模型测活
  |
  +-- 502/503/504、连接中断、服务过载、模型容量不足
        |
        +-- 直接模型测活
```

认证失败、人工暂停、明确的额度限制终态和永久错误不进入插件探测。上下文耗尽仍走核心的
压缩后恢复流程，不由站点插件接管。

所有 `429` 都执行余额查询，不要求插件从错误内容证明断开原因。只有余额接口明确形成
`insufficient` 结论时才停止本轮自动恢复；`available` 和 `unknown` 都进入模型测活。

本设计不维护连续 `429` 计数，也不因连续健康探测而熔断。如果站点存在不反映在余额接口
中的频率、并发或每日次数限制，可能发生重复恢复；这是采用余额与模型结果作为唯一门禁的
明确取舍。

## 模型恢复确认

插件探测只在可恢复错误发生后启动，不进行常驻轮询。每个恢复周期采用以下固定规则：

- 第一次测活立即执行。
- 一旦观察到 `false`，之后第一次有效 `true` 即形成 `false -> true`，确认恢复。
- 如果本周期从未观察到 `false`，需要间隔至少 `probeIntervalMs` 的连续两个 `true` 才确认
  恢复。
- `unknown` 会打断连续 `true`，但不会清除本周期已经观察到的 `false`。
- 同一周期内不并发执行两次 `checkModel`。
- 新恢复周期会取消旧周期定时器、在途请求和未完成回调。

## Codex 恢复动作

插件确认模型恢复后只返回结果，不直接继续 Codex。核心必须再次读取并验证当前状态，防止
探测等待期间发生人工操作或新 turn：

- goal thread：在状态仍可恢复时重新激活同一个 goal。
- 普通 thread：在没有新 turn 替代失败 turn 时发送新的继续 turn。
- 子代理 thread：通过最近可接受直接输入的父 thread 恢复；父 turn 活跃时 steer，空闲时
  start。
- 人工暂停、新 turn、任务完成或永久终态会取消待执行恢复。

继续提示要求 Codex 先检查当前状态，避免重复已经完成的有副作用步骤。核心仍不能保证工具
操作恰好执行一次，该风险沿用现有 watchdog 安全说明。

## 失败处理

- 配置缺失、JSON 无效、模块解析失败、工厂抛错或 API 主版本不匹配：拒绝启动。
- 内置或自定义余额查询失败：对应账户为未知；不能伪装成零余额。
- `checkModel` 抛错、超时或返回非布尔值：本次为 `unknown`，不恢复，等待下一次探测。
- 探测错误只记录插件 ID、站点和脱敏账户 ID；不得记录 API Key、请求认证头或完整配置。
- 插件运行时契约错误终止当前恢复周期，但不让未捕获异常结束 watchdog 进程。
- watchdog 关闭时取消所有插件异步工作，不留下定时器或未处理 Promise。

## 兼容性

- 未传 `--plugin` 时不加载任何插件，现有核心恢复路径及其配置保持不变。
- 插件接口使用整数 `apiVersion`。主版本不匹配时拒绝加载，不做隐式兼容转换。
- 配置格式版本和插件接口版本分别验证。
- 插件只能依赖公开 `host` 契约，不能导入 watchdog 的内部源码路径。
- 新增技术栈不要求发布 watchdog：站点插件使用 `stack: "custom"` 并实现
  `checkBalances`。

## 测试策略

### 单元测试

- 插件名校验和跨平台用户配置路径解析。
- npm 包和相对本地模块解析。
- 配置缺失、JSON 无效、模块异常、工厂异常和 API 版本不匹配。
- `sub2api`、`newapi` 余额响应归一化。
- `any`、`all`、`sum` 在成功、不足、部分未知和全未知情况下的三态结果。
- 自定义 `checkBalances` 覆盖内置适配器。
- `checkModel` 的布尔、非布尔、抛错和超时结果。
- `false -> true`、`true -> true`、`true -> unknown -> true -> true` 的确认序列。
- 新周期取消旧请求、关闭插件和抑制过期回调。

### 集成测试

- `429 -> 余额不足` 不执行模型测活，不恢复 Codex。
- `429 -> 余额可用/未知 -> 模型恢复` 执行核心恢复。
- 其他可恢复上游错误跳过余额查询，直接测活。
- 插件确认结果驱动 goal、普通 thread 和父 thread 三种既有恢复路径。
- 探测期间人工暂停、新 turn 或完成状态取消恢复。
- 未启用插件时全部现有测试保持通过。

### 验收标准

- 用户只传 `--plugin <name>` 即可加载同名用户级配置和对应 npm/本地模块。
- 增加一个自定义站点插件不需要修改 watchdog 源码。
- API Key 不出现在测试快照、普通日志或启动错误中。
- 一个恢复周期最多存在一个模型测活请求和一个等待定时器。
- 插件永远不能绕过核心状态复核直接发送 Codex 恢复 RPC。

## 方案取舍

采用“每站点一个插件包”的单层模型，而不是纯 JSON 加零散脚本，也不引入技术栈适配器和
站点插件两层发现机制。它保留独立发布能力，同时让用户只管理一个插件名称和一个配置文件。
`sub2api/newapi` 作为主程序公开辅助能力提供；特殊站点可以覆盖余额查询和模型测活，而不
扩大核心恢复状态机。
