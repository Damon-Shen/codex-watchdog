# README 完整重写设计

日期：2026-08-11

## 目标

完整重写仓库根目录 `README.md`，使其准确反映当前项目已经从单一 `/goal` 恢复器演进为：

- Codex 本地故障恢复启动器。
- TUI 与实验性 `app-server` 之间的回环 WebSocket 代理。
- 支持 goal、普通 thread 和子代理父线程路由的恢复控制器。
- 可通过命名插件扩展不同中转站余额查询和模型测活的运行时。
- 随仓库提供 ai.input.im 可复制插件和多账户 Sub2API 配置示例。

README 使用中文主叙述，保留必要的英文技术术语、命令和标识符。内容同时服务首次使用者和插件开发者：首屏以快速使用为主，后半部分解释恢复规则、插件契约和安全边界。

## 必须保留的信息

- 原作者：`flowing-water1`。
- `LICENSE` 中的 `Copyright (c) 2026 flowing-water1` 归属。
- Linux.do 社区鸣谢及其链接。
- MIT License 链接。

README 的作者部分不得暗示插件模式替换或转移了原项目作者权利。

## 信息架构

README 按使用流程组织：

1. 项目名称和一句话定位。
2. 核心特性。
3. 环境要求。
4. 快速安装和无插件启动。
5. ai.input.im 插件快速配置。
6. 恢复决策与边界。
7. 通用插件系统和不同站点的扩展方式。
8. 环境变量、日志与安全边界。
9. 测试、项目结构和延伸文档。
10. 原作者、社区鸣谢与许可证。

普通用户应能只阅读前五部分完成安装和启动。开发者继续阅读后续部分即可理解核心与插件的职责划分，而无需先阅读实现源码。

## 安装与使用

README 同时提供两种本地安装方式：

- 普通用户：克隆仓库、安装依赖后执行 `npm install -g .`，获得全局 `codex-watchdog` 命令。
- 开发者：执行 `npm ci` 和 `npm link`，使全局命令指向开发工作区。

无插件模式使用 `codex-watchdog`。插件模式只增加 `--plugin <name>`，其余参数原样传给 Codex。README 必须保留 `-C`、`resume` 和禁止用户自行传入 `--remote` 的说明。

## ai.input.im 快速配置

ai.input.im 定位为仓库提供的重点示例，不是核心硬编码站点。README 提供 POSIX 和 PowerShell 复制步骤：

- 将 `plugins/aiinput.mjs` 复制到用户插件配置目录。
- 将 `plugins/aiinput.example.json` 复制并重命名为 `aiinput.json`。
- 替换模型、账户 ID、所有 API key 和余额阈值。
- POSIX 系统把 JSON 权限限制为 `600`。
- 使用 `codex-watchdog --plugin aiinput` 启动。

README 明确说明 ai.input.im 使用：

- `GET https://ai.input.im/v1/usage` 查询每个配置账户的余额。
- `GET https://status.input.im/api/status` 精确查询配置模型的状态。

详细配置字段和完整安装说明链接到 `docs/plugins/README.md`，根 README 不重复维护全部契约。

## 恢复规则

README 使用紧凑流程准确描述当前行为：

- 插件模式下所有 HTTP 429 都先查询并聚合余额。
- `insufficient` 停止当前恢复；`available` 和 `unknown` 进入模型测活。
- 502、503、504、连接中断、服务过载和模型容量错误跳过余额查询，直接进入模型测活。
- 模型探针明确返回 `true` 或 `false`；HTTP、取消、超时和解析异常视为 `unknown`。
- 上下文耗尽走 compact 后恢复流程，不经过中转站余额判断。
- 人工暂停、认证错误、永久错误、预算耗尽和已完成任务不自动恢复。
- 恢复动作前必须重新检查 thread 或 goal 的最新状态。
- 普通 thread 使用谨慎的继续提示；无法直接接收输入的子代理将恢复提示路由给父 thread。

README 必须明确声明：项目不维护连续 429 次数，也没有“余额健康但连续 429”的熔断器。

## 插件扩展模型

一个中转站对应一个命名插件和同名 JSON 配置。核心提供：

- `sub2api` 和 `newapi` 内置余额适配器。
- 多 API key 独立查询及 `any`、`all`、`sum` 聚合策略。
- HTTP 超时、取消、生命周期和 API key 日志脱敏。
- 模型恢复确认采样及最终 Codex 状态复核。

站点插件负责：

- 站点特有的状态 URL、请求方法、请求头和响应解析。
- 精确识别配置模型是否明确可用。
- 在 `custom` 技术栈下实现特殊余额解析。

`checkModel` 只在站点明确给出结果时返回严格布尔值；无法判断时抛错，由核心归一化为 `unknown`。其他站点响应格式与 ai.input.im 不同，只需编写新的站点插件，无需修改或重新发布 watchdog 核心。

## 安全与兼容性

README 保留并强化以下边界：

- watchdog 只监听 `127.0.0.1`。
- 插件是受信任的进程内 Node.js 代码，不是安全沙箱。
- API key 位于用户配置目录，不应提交进仓库；日志会脱敏配置中的 key。
- 恢复可能重试已有外部副作用的任务，因此无人值守任务仍需可安全重试。
- Codex `app-server` 是实验接口，升级 Codex 后应重新运行 live smoke test 并进行受监督验证。

不宣称 watchdog 可以保证任务永不中断或兼容所有未来 Codex 版本。

## 验证标准

重写完成后必须确认：

- README 中的相对链接和引用文件存在。
- 安装、复制、启动、环境变量和测试命令与当前代码一致。
- ai.input.im 示例不含真实密钥、余额或用户配置内容。
- README 不包含已废弃的旧探针模式或连续 429 熔断行为。
- 原作者、版权、Linux.do 鸣谢和 MIT License 均保留。
- `npm test`、`npm run check` 和 `git diff --check` 通过。

## 交付

实现只重写根目录 `README.md`，不修改运行时代码、插件、配置示例或许可证。README 作为独立提交推送到 `Damon-Shen/codex-watchdog` 的 `main`。
