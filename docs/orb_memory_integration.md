# Orb 人格与记忆接入：接口审计与最小方案

日期：2026-11-10。承接 11 月 9 日路线重置；当前完成接口审计和来源桥接基础，尚未完成 Orb 在线闭环。

后续进展：干净会话准备、原生日志恢复及迟到通知隔离已完成离线验证；前台切换接口与持久门禁尚待实现，见 [切换验证与最小接口](orb_memory_cutover.md)。

最新开发进展：切换事务、持久门禁、SQLite 版本提供器与跨进程互斥已实现并完成离线/原生夹具验证，仍未安装到真实 Orb。真实版本查询暴露每次约 174 ms 的 CLI 启动开销，先处理常驻查询，再做 UI 验收。见 [真实版本接入与互斥](../log/2026-11-10-Orb真实版本接入与跨进程互斥.md)。

同日后续：常驻版本 worker 已完成，原生夹具中 25 次版本检查累计从 4351 ms 降至 293 ms，保留逐次 SQLite 校验。下一步为后台通知投递确认和隔离 UI 验收，见 [常驻版本查询](../log/2026-11-10-Orb常驻版本查询与延迟复核.md)。

## 实际安装与启用证据

- `E:/dsh/DeepSeek Harness.exe` 文件版本为 **0.2.2-rc.1**，app.asar 内 session、session-controller、agent-loop、llm、system-prompt 包也为 **0.2.2-rc.1**。旧日志中的 rc.2 / rc.5 不适用于这次安装。
- 用户 profile 中 Orb 为 **0.2.1**，工作区配置指向 `dsh_orb_work`。
- profile 的 bundle 列表为 base、web-app、rag-workbench、orb；旧助手和 observe 仍为已安装 link 依赖，但不在 bundle 列表。用户 patch 未发现旧助手挂载条目。不能据此证明运行中进程已重载，也未核实所有后台 worker。
- 没有启动/停止用户应用、修改 C 盘配置、读取用户对话历史或正式记忆数据。

## 已核实消息链

安装 Orb 的 `dist/host/index.js`：`createSession` 使用 `computer-use`；`submitPrompt` 经 `sessionController.prompt` 发送真实前台文本、随机 requestId 与客户端时区。

Harness 的 `dsh-api-session-controller/lib/index.js`：`prompt` 将 source 设为 `kind=user`，把 requestId 记录为 `rpcId`，再交给命令/消息入口。这说明来源类型本身不证明由人直接发出。

Orb 的 `dist/computer-use/code-agent.js`：后台创建 `standard` 会话，也调用相同 prompt API，requestId 为 `code-agent-<UUID>`。其创建参数未显式声明 parentSessionId，不能只靠父子字段区分。前后台关联由 Orb delegation/registry 保存；本版不导入后台会话，不为临时任务目录建立个人库。

桥接要求精确真实路径 + 前台预设 + 非子会话 + user 来源 + append 事件 + 消息/RPC 标识，同时排除后台 RPC 前缀。来源键绑定 session/RPC，底层再绑定 user/project。主窗口向同一前台会话发送的文本也会被视为用户来源；精确球 UI 来源目前没有单独的宿主标记。

## 动态上下文复核

用当前安装 SDK 的真实 AgentLoop、内存 SessionStore、原生工具执行器和假模型完成三次请求，无网络、无真实模型调用。新版 class Service.init 生命周期及工具执行器已显式初始化，旧夹具不能原样运行。

`systemPrompt.context` 确实可贡献数据上下文，`interpolate:false` 保留字面文本，宿主将其标为 runtime-context。清空贡献后，同轮工具循环和下一用户请求依然包含旧正文。证据：`results/memory/context-hook-audit-20261110.json`，包含源码 SHA-256。

此外新版 AgentLoop 会冻结请求和 messages，并记录请求 surface。不能在 llm/stream 中随手改消息数组来冒充正式上下文替换。仅追加“此前记忆失效”也无法实现正文移除。

结论：自动注入暂不接入真实 Orb。下一步验证 **当记忆版本/开关变化时，在下一请求前切换到干净会话** 的宿主入口与前台关联；保留旧历史但不继续作为请求输入。必须处理在途回答、工具调用配对、后台完成通知和重启后绑定；若采用 surface 替换，须覆盖派生回答/摘要，而不只是 runtime-context 节点。两种方案都未在本轮实现或验收。

## 作用域、控制与后续安装

当前桥接仅把这个 Orb 工作区映射到既有项目作用域，继续复用其已有效偏好，不迁移数据库，不批量导入历史。全局个人记忆和项目记忆的双层查询仍待独立设计，不能把当前项目映射称为已完成全局身份体系。

关闭沿用 V2：停止采集/整理/自动检索并撤销待处理队列，不删除既有记忆。未来纠正、撤销入口复用原 `/memory` 人工命令，且必须与干净会话策略绑定。本次桥接没有把这些命令挂到 Orb。

拟由独立应用级插件拥有一个整理调度器，依靠数据库十分钟租约、批次幂等和重试上限处理多实例/重启；前台会话不各自创建定时器。整理请求继续独立无工具，不使用 code_agent 偶发委派。新调度器尚未实现。

人格先使用 E 盘可版本化配置，只描述表达偏好，不替换 Orb 操作规则或授权；不要求后台 worker 输出角色口吻。人格加载器尚未实现。

在来源、调度、干净上下文与版本兼容全部验证后，才准备独立 bundle 与可回退 profile 变更，并进行真实 Orb 偏好输入→跨日整理→新会话召回验收。目前无需用户重启。

## 本轮验证范围

- Node 21 项通过：新桥接 5 项、旧 Host 13 项、旧每日/失效测试 3 项。
- Python V2 17 项通过：新增 Orb 来源/幂等/跨日采纳和未知来源拒绝，原测试保持通过。
- 当前 SDK 原生夹具 3 次假模型请求通过，确认上下文残留问题存在。
- Node 首次测试受子进程 EPERM 阻挡，改用 test-isolation=none 后通过；Python 首次受临时目录权限阻挡，获准在沙箱外运行隔离测试后通过。初次 Python 失败可能遗留其自建空临时目录，未扫描或删除不确定归属的 Temp 目录。
- 这些证据不代表真实 Orb 消息已采集、跨会话召回已接通或用户已验收。
