# ai.input.im 中转站插件设计

日期：2026-08-11

## 目标

为已完成的 watchdog 命名插件运行时提供一个可直接复制使用的 ai.input.im
站点插件。用户配置多个 API key 和目标模型后，仅需运行：

```bash
codex-watchdog --plugin aiinput
```

插件只承担 ai.input.im 特有的模型状态接口解析。余额查询、多账户聚合、超时、
取消、日志脱敏和 Codex 恢复仍由 watchdog 核心负责。

## 交付形式

仓库新增两个可复制文件：

- `plugins/aiinput.mjs`：站点插件实现。
- `plugins/aiinput.example.json`：脱敏的多账户配置示例。

第一版不创建 npm 包，也不把 ai.input.im 逻辑内置到 watchdog 核心。用户将两个
文件复制到用户配置目录，并将示例配置重命名为 `aiinput.json`。

## 配置

`aiinput.example.json` 使用通用插件配置契约，关键字段固定为：

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

`stack` 使用 `sub2api`，因此插件不实现 `checkBalances`。watchdog 使用每个 API key
请求 `GET https://ai.input.im/v1/usage`，并按 `balancePolicy` 形成 `available`、
`insufficient` 或 `unknown`。

## 插件接口

`plugins/aiinput.mjs` 默认导出工厂函数，返回：

```js
{
  apiVersion: 1,
  id: "aiinput",
  async checkModel({ signal }) {}
}
```

`checkModel` 通过 `host.http.request` 固定请求：

```text
GET https://status.input.im/api/status
```

请求使用主程序传入的 `signal`，不自行创建计时器。插件解析 `services` 数组，
精确匹配 `service.model === config.model`，并只在 `service.last.ok` 是布尔值时返回该值。

## 失败语义

以下情况不证明模型明确不可用，因此插件抛错，由主程序归一化为 `unknown`：

- HTTP 响应非 2xx。
- JSON 解析失败或顶层 `services` 不是数组。
- 找不到与 `config.model` 精确匹配的项。
- 匹配项的 `last.ok` 不是布尔值。
- 请求被超时、新恢复周期或关闭操作取消。

只有接口明确返回 `last.ok: false` 时，`checkModel` 才返回 `false`。恢复确认规则仍是
通用运行时的 `false -> true` 或间隔采样的两个连续 `true`。

## 文档

`docs/plugins/README.md` 新增 ai.input.im 专节，说明：

1. POSIX 和 Windows 的目标配置目录。
2. 复制和重命名两个文件。
3. 替换模型名称、多个 API key 和余额阈值。
4. 限制 JSON 文件权限。
5. 运行 `codex-watchdog --plugin aiinput`。

## 测试

新增离线插件测试，使用伪 host 验证：

- 请求固定的状态 URL 并原样传递 `signal`。
- 目标模型的 `last.ok: true` 返回 `true`。
- 目标模型的 `last.ok: false` 返回 `false`。
- 模型匹配是精确的，不会选择名称相似的其他模型。
- 非 2xx、缺失模型、非布尔状态和畸形 payload 均抛错。
- 示例 JSON 可解析，且声明 `sub2api`、ai.input.im 域名和多账户。

自动测试不请求公网，避免将站点故障或网络可用性变成 CI 的不稳定因素。

## 验收标准

- 将示例文件复制到用户配置目录并填写 key 后，`--plugin aiinput` 能通过启动校验。
- 429 继续使用全部账户的 Sub2API 余额结果，不引入连续 429 计数或熔断。
- 模型探测只返回 ai.input.im 状态接口中目标模型的明确布尔状态。
- API key 不出现在插件源码、自动测试输出或普通日志中。
- 无插件路径和其他站点插件行为不变。
