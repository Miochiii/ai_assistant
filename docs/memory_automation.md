# 记忆自动化第一批：桌面点击子任务 checkpoint

2026-10-29，磁盘插件 0.6.5。实现依据：`log/2026-10-29-memory-automation-and-executor-review-decision.md`。

当前是**接口和离线验收完成，正式自动化未启用，运行中插件加载及两会话现场验收未完成**。首版接 Harness `desktop_click`，并已离线接入 `desktop_replay` 的整个程序任务边界；独立 PreAct CLI 直接调用、普通聊天和自动检索/注入没有接入。一个点击/程序子任务结束不能表示用户整个任务成功。

## 用户开关

只从人类 `/memory` 命令修改设置，模型四个记忆工具不变。设置保存在同一个独立 SQLite 的 `memory_automation` 表，绑定宿主计算的 user/project；未配置默认关闭。

```text
/memory automation {}
/memory automation {"auto_checkpoint":true,"retention_days":30,"acknowledge_retained_body":true}
/memory automation {"auto_checkpoint":false}
/memory automation {"preview_expired":true}
/memory checkpoint-run <run_id>
/memory refresh
```

启用时必须明确保留天数（1–365 天）并承认到期仍保留磁盘正文；这里的 30 天仅是可选择的示例，本轮未代用户接受。到期停止默认恢复/召回，预览只列 ID/到期时间；删除仍需 `/memory plan`、`confirm:true`、匹配 `plan_id`。关闭不会抹掉既有记录。`auto_recall` 保持独立关闭，启用会返回 `AUTO_RECALL_NOT_IMPLEMENTED`。

同意来源只能是真实人类命令事件。旧命令重复投递幂等，不能重新开启已关闭的设置。不存在的项目目录不生成自动化上下文；无来源、项目不匹配、设置未知、策略版本不兼容、同意来源已删除均不会写自动记忆。数据库损坏如实报错，显式入口仍保持独立。

## 触发、来源与内容

`memory.js` 在实际用户消息上记录稳定请求身份。点击启动前只在有效同意下捕获 scope、请求引用、同意事件 ID 和当前请求实际使用的记忆依赖，写入 run 的 `memory_context`。不复制用户消息正文。

`action.js` 先运行原执行器，再持久化 `ended` 边界，最后通过 `memory-runtime.js` 调用宿主 `autoCheckpoint(session, {run_id})`。接口不接受模型摘要或 `consent:true` 来授权；Python 从真实账本读取事实，在同一个 SQLite 写事务里重查同意、写来源并提交 checkpoint。关闭命令和 checkpoint 按 SQLite 提交顺序生效；旧同意下排队的任务在关闭再启用后也不会补写。

来源分成三个事件：

- `harness_user_reference` / `origin=user`：只保留真实用户事件引用，明确 `text_retained=false`，不伪造用户原话。
- `desktop_run_ledger` / `origin=tool`：终结原因、执行器 stopped/unknown、run 证据引用。
- `desktop_executor_receipt` / `origin=tool`：输入 sent/not_sent/unknown、已记录步骤、verification 及其子任务范围。

核心 checkpoint 的五字段格式不变。内容由账本确定性生成，goal 表示请求对应的桌面子任务引用，next_step 只是重新检查证据/观察/授权的建议；不保存截图、坐标、标题、授权令牌、整段聊天或 stdout。状态 completed 仅表示子任务生命周期结束，`task_success_verified=false` 始终保留。取消、超时、异常保留 unknown，不自动重试输入或声称回滚。

旧的 interrupted run 若尚无明确执行器恢复记录，返回 `executor_recovery_required`，不推断执行器已停止。显式标记 unknown 的新终结事件可保存未知状态，但恢复绝不自动执行。

## desktop_replay 任务边界（离线）

`preact_replay.py` 现在可以从宿主环境读取 `DSH_MEMORY_CONTEXT`：

- Node 的 `memoryRuntime.context(session)` 在有效 `auto_checkpoint` 同意下构造 scope/memory_context
- Python 校验 scope、session、request/user/consent/source 字段；不匹配或格式错误时退回无自动记忆
- run ledger 记录 memory_context、pending checkpoint_write、`executor_state=stopped` 和逐步 facts
- Node `replay.js` 在 replay 结束后调用 `autoCheckpoint(session,{run_id})`，再通过 run ledger 刷新 `checkpoint_write`
- 没有把模型摘要或 `consent:true` 当授权；正式开关未启用

这仍是离线/单测接入：没有写真实项目记忆、没有模型调用、没有桌面输入。当前运行中的 Node 插件需要重启后才能加载该路径。

## 修正后的 live click 与 replay 状态（2026-10-30）

修正 `input_delivery_observed` fallback 后，新的空白点击 run `ed1903b1-96f5-41d1-9d8f-77c0d0599b9e`：

- `input_delivery=sent`
- `checkpoint_facts=[{step:1,input_delivery:sent,verification:unknown}]`
- checkpoint `46e01782-4ed4-4cd9-b56d-a4bdd6c251fa` saved
- resume active，`automatic_execution=false`
- 来源 user/tool 分离

这说明 `desktop_click` 首次 live checkpoint 已正确工作。

`desktop_replay` 的 v4 自动 checkpoint 现已 live 通过：run `9ef78d59-00cc-4e72-a9b2-aafdb63c547d` 两步完成、`memory_context_available=true`、`checkpoint_facts` 两条、`input_delivery=sent`、`checkpoint_write=saved`，memory `01b067a6-0813-49a6-85d2-c64f6f929176`；resume active、`automatic_execution=false`、`task_success_verified=false`。之前的失败根因是 `replay.js` 把 `requireSession()` 字符串传给 `memoryRuntime.context()`，而 `runContext` 需要 `exec.agent.session` 对象；已改为对象并加 Node 测试。证据 `results/memory/replay-checkpoint-live-20261030.json`。

## 首次 live checkpoint（原始字段 bug，已修正）

2026-10-30，用户已启用本项目 `auto_checkpoint`、30 天。一次 `desktop_click` 空白点击确实生成了 saved checkpoint：

- run `f8c58da3-f153-4555-bd55-d349e58a2527`
- memory `ec79ed21-8251-45b4-b5ca-e8cb0abb8d83`
- operation `auto-checkpoint-d79170...`
- `checkpoint_write.status=saved`、`retention_days=30`

但暴露字段 bug：执行器回执用 `input_delivery_observed`，`action.js` 只读 `input_delivered`，因此 run 写入 `input_delivery=unknown`、`checkpoint_facts=[]`，尽管实际发送 3 个事件且 `input_delivery_observed=true`。

已修：

- `action.js` 同时读取 `input_delivered` / `input_delivery_observed`
- `preact_replay.checkpoint_facts` 同样 fallback
- 测试改为覆盖执行器真实字段

修正后已通过：第二次空白点击 run `ed1903b1...` 写入 `input_delivery=sent`、一条 fact、checkpoint `46e01782...`；重启后第三次 click `0c373e11...` 写入 `19f3806b...`，仍正确。证据 `results/memory/live-checkpoint-corrected-20261030.json`。

## 幂等、失败、依赖和到期

operation ID 由 scope/run/终结事件/策略版本哈希得到。相同事件相同内容只保存一条；不同内容冲突；已删除 operation 返回 `OPERATION_DELETED`。来源和记忆提交同事务，写失败不留半份自动来源。

写失败记录到 `checkpoint_write=failed`，保持实际运行结果不变。宿主仅对存储不可用/超时做最多 3 次、50/100ms 退避的存储重试；核心持久化失败次数，已提交但未回写账本的结果可用同 operation 对账恢复，不重跑桌面。`checkpoint-run` 是人类补投宿主入口，也检查当前同意和原 run 范围；达到持久化失败上限则返回 `retry_exhausted`。非存储错误不自动重试。

请求依赖在启动前固定，后续新用户消息不能改变排队摘要的来源/依赖。显式 resume 返回的 checkpoint 与其父依赖登记到当前请求，供跨轮派生摘要继承。核心继续负责修订、撤销、删除引起的失效；没有新增正文缓存或待注入副本。运行账本只保留 ID/状态，不因忘记记忆而删除独立证据。

自动 checkpoint 用现有 `valid_from/valid_to` 保存到期时间，未改变手动事实的期限。`resume` 的自动来源附 `evidence_availability`，对应 run JSON 不在时显示 unavailable；这只检查 run 文件可读，不证明原始截图等证据均在。

Schema v1 增量创建设置表，不改变旧表或旧 checkpoint 格式。未带有效期的既有 operation digest 保持兼容。

## C1 离线基础（2026-10-31）

按 GPT 决策先实现暴露登记/失效闸门，不接自动注入：

- `memory_context_exposures`：只存 scope/session/request/generation、memory ID 列表、stage 和失效元数据，不存正文
- `memory_context_states`：`clean | needs_refresh` 实际使用；`rebuilding | blocked` 仅保留为旧 schema 预留，当前不写入
- `register_exposure`、`promote_exposures`、`context_state`、`invalidate_context`、`context_generation`、`refresh_context` 核心接口
- `revoke`/`forget` 自动把相关 exposure 标为 invalidated、context 标为 needs_refresh
- `context_state` 在检查时识别撤销/删除/到期，不需要只靠定时器
- host `recall`/`resume` 前置检查 context_state；成功结果登记 metadata-only exposure
- host 从核心 `context_generation` 恢复 generation，不再硬编码 1；跨重启不会误用旧 generation
- `needs_refresh` 时 `/memory refresh` 会 bump 到新 generation 并写 `context_refreshed` audit；旧 generation 保留为审计，旧对话历史不重写
- `llm/stream` 只在提交前尽力 promote；失效/错误只记录，绝不阻断 `next()`，避免一次 forget 炸掉整段会话
- 记忆工具错误在工具边界转成结构化 `{ok:false,error_code,message,recovery}`，前端不再只剩 `UNKNOWN`

错误码约定：

| 错误码 | 含义 | 前端/恢复 |
|---|---|---|
| `CONTEXT_NEEDS_REFRESH` | 旧 generation 因 revoke/forget/到期失效 | 本轮禁用记忆工具；运行 `/memory refresh` 或新开会话 |
| `CONTEXT_REFRESH_FAILED` | 刷新 generation 失败 | 记忆工具保持禁用；新开会话或稍后重试 |
| `INVALID_CONTEXT_GENERATION` | generation 越界/非法 | 刷新或新会话 |
| `MEMORY_UNAVAILABLE` | 记忆已删除/撤销/到期 | 不重试旧 ID；重新召回或忽略 |
| `MEMORY_TIMEOUT` / `STORAGE_UNAVAILABLE` | 核心超时/存储暂不可用 | 可重试读取；不伪造记忆 |

已验证：Python 全量 **236**，新增 8 项 isolation 测试；Node **93**，host 单测 **13**；真实 CLI host 检查 **15**；记忆自动化/账本 **22**。live 已验证 recall 后下一次模型请求前 stage 从 `prepared` 变为 `submitted_to_adapter`、context clean；C1 失效恢复已改为非阻塞 + `/memory refresh`，C2 自动干净切换、C3 surface 重建未完成。`auto_recall` 仍为 0。证据 `results/memory/context-gate-live-20261031.json`、`results/memory/context-exposure-c1.json`。

## 验收与下一步

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\check_memory_automation.py
node scripts\check_memory_host.mjs
& '.\.venv\Scripts\python.exe' -B -m unittest discover -s tests -q
node --test tests/*.mjs
```

证据：`results/memory/auto-checkpoint-offline.json`、`replay-checkpoint-integration.json`、`replay-checkpoint-live-20261030.json`、`live-checkpoint-corrected-20261030.json`、`new-session-resume-20261030.json`、`host-integration.json`、`python-regression-20261029.txt`、`node-regression-20261029.txt`、`dsh-memory-contract.json`、`cleanup-20261029.json`。离线宿主使用隔离 SQLite、合成 run 和两会话对象；live click/replay 与真实新 Harness 会话 resume 已通过。旧错误 checkpoint 已由用户显式清理；当前余 3 个正确测试 checkpoint。自动检索仍关闭。

下一步：read-only 状态核对已完成（File 菜单关闭、0 input）；还需 replay 嵌套取消/恢复现场检查，以及决定是否清理剩余 3 个测试 checkpoint。第二轮自动检索/注入仍受上下文历史残留审计阻塞，需先做 surface 重建或新会话策略，不能直接打开。
