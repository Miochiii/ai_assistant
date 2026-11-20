# 重启后只读核对与第二批上下文入口审查

日期：2026-10-29（UTC+08:00）。用户报告已重启 DeepSeek Harness，要求继续下一步。

## 当前事实

- Computer Use `list_apps` 确认一个运行中的 Harness 窗口，标题 `Desktop trial offline — DeepSeek Harness`；窗口 ID 919494。窗口发现不等于插件新版已加载。
- 第一次读取窗口状态返回 `Computer Use app approval timed out`；刷新窗口绑定后重试一次，返回 `FrameArrived timed out: timed out waiting on channel`。未得到成功截图，未向应用发送输入；当前不能完成实际宿主命令或点击验收。
- 本机 profile 的 `dsh-desktop-observe` Junction 指向本项目源码，磁盘版本 0.6.5。只读打开正式 SQLite（mode=ro），本项目 scope 为 `workspace-b7fd5dfd76932392d6fd1296`；`memory_automation` 表尚不存在，没有项目启用设置，因此继续默认关闭。只检查设置元数据，没有输出真实记忆正文或改写数据库。
- 已向用户提出具体现场范围：仅本项目临时启用、30 天可用期且到期保留磁盘正文、test.txt 记事本低风险点击、另一会话恢复后关闭。未收到范围选择之前不启用；也不伪造人类命令来源绕过设置。

## 本轮独立推进

已核对第二批所需的本机真实接口，新增原生夹具 `scripts/check_dsh_memory_context.mjs`：

1. 确认 `systemPrompt.context`、`interpolate:false` 与 Harness 自己的 `source.kind=runtime-context` 投影，可以把带数据标记的内容提供给模型，未进入 system/developer。
2. 三次假模型调用证明：清空 context 贡献后，下一工具循环及后续新请求的 messages 仍包含先前正文。清缓存/停止新贡献不能清除历史；自动注入需要先处理 surface 重建或改用新上下文，不能直接接上便宣称撤销/删除完整。
3. 证据 `results/memory/context-hook-audit-20261029.json`；接口说明与具体限制 `docs/memory_context_hook_audit.md`。没有正式自动注入实现或启用。

全部使用内存会话和合成内容，0 网络、0 付费模型调用、0 桌面输入。没有改运行中插件源码或要求为了本轮审查再次重启；新增内容只有验收脚本、报告和文档。

## 待继续

现场仍需成功读取 Harness 状态并执行真实命令来确认 0.6.5 加载。可由用户在当前项目会话执行 `/memory automation {}`；该状态命令无需启用自动化，也不调用模型。随后在明确的启用范围/保留期和有效桌面任务授权下，继续真实触发、第二会话恢复、关闭验证。当前不标现场验收通过。
