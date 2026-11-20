# Harness 原生记忆上下文入口核对

2026-10-29。仅核对已安装 DSH 0.2.1-rc.2 的内置源码和内存夹具，不连接运行中应用、不启用正式记忆。此项是第二批自动检索/注入的接口准备，不代表第二批已实现。

## 已确认的入口和顺序

- `@deepseek-ai/dsh-system-prompt` 的 `systemPrompt.context({name, order, text, interpolate:false})` 是真实支持的动态上下文接口。`text` 可为同步函数；异步 SQLite 检索须在此前的可信请求准备阶段完成，不能直接返回 Promise 冒充文本。
- 数据经 `renderContextSections` / `joinContextSections` 由 AgentLoop 转成带 `source.kind=runtime-context` 的消息；消息 wire role 为 user，但来源明确不是 `source.kind=user` 的用户原话。无需伪造用户消息或工具记录，不使用 `.section()` 填入高权限 system 指令。
- Loop 在组装后、每次 provider 请求前调用 `refreshContext`。因此每条新用户请求的召回批次要绑定真实请求 ID；工具循环和网络重试只能复核该批次的版本/状态，不能无差别重复检索/累积依赖。
- `llm/stream` 确有中间件入口，可以观测本次交给适配器的请求；它不证明远端服务或模型实际接收。该阶段的 session surface 已构造，不能只临时修改消息来掩盖持久化历史里仍有正文的问题。

源码定位（安装包路径下 `dsh/node_modules/@deepseek-ai`）：`dsh-system-prompt/lib/index.js` 的 context/refreshContext，`dsh-agent-loop/lib/index.js` 的 runtime-context 投影和请求前刷新，`dsh-llm/lib/index.js` 的 `llm/stream` waterfall。文件指纹记录在验收 JSON。

## 原生夹具结果

入口：`scripts/check_dsh_memory_context.mjs`。使用真实 AgentLoop、SessionStore、ToolRuntime、SystemPrompt 和假模型，禁用 fetch；会话只在内存，内容明确是合成记忆。第一轮假模型调用假工具清空 context；随后同一轮下一请求、再一条新的用户请求检查实际交给适配器的 messages。

| 检查 | 结果 |
| --- | --- |
| 第一次请求包含合成 context | 是 |
| 正文进入 system/developer 指令 | 否 |
| `interpolate:false` 保留正文中的双花括号 | 是 |
| 来源由 Harness 生成为 runtime-context | 是 |
| 清空贡献后下一工具循环仍包含旧正文 | 是 |
| 后续新用户请求仍包含旧正文 | 是 |

这说明清除 context 提供器/召回缓存只能停止新增贡献，无法保证已进入会话历史的正文不再出现在后续请求中。该夹具不声称做了真实 memory forget；它准确验证了“清贡献不足以清历史”的原生行为。

## 第二批实现约束

自动检索仍应默认关闭，沿用显式 recall。后续需先验证宿主 surface 重建/替换是否能在不伪造来源、不破坏工具配对的条件下排除已失效的记忆及派生摘要；若当前会话无法安全排除，按决策日志改用新的干净上下文，并如实说明旧会话/日志仍保留历史。不能以一句“旧快照已失效”承诺模型已完全忘记。

在上述行为确认前，不接入正式自动注入，不替用户选择保留/删除策略。接口已找到，尚未完成的是请求范围、提交前版本复核、历史残留清理及依赖传播的接入。

证据：`results/memory/context-hook-audit-20261029.json`。3 次假模型请求，0 网络、0 付费模型请求、0 桌面动作，正式设置未改变。
