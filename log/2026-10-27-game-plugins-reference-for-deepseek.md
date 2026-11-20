# 给 DeepSeek 的游戏插件源码参考与桌面助手实施建议

日期：2026-10-27（UTC+08:00）  
项目：`E:\file\agent\ai assistant`  
用途：供后续开发参考，不是插件安装脚本，也不代表下述功能已经实现。

## 1. 本轮结论与范围

优先借鉴三个项目的运行管理、增量观察、动作后验证、会话恢复和方法评测。继续维护本项目的通用视觉与鼠标键盘底座；游戏适配器只作为源码参考，不加入当前生产工具链。

本轮只读了本地源码、清单和文档，未安装依赖、启动游戏、注册计划任务或调用模型。Mindcraft 未下载，不作为本轮实施依赖。没有对这三个项目做完整安全审计或运行验收。

| 本地源码目录 | package.json 声明版本 | 上游 |
| --- | --- | --- |
| `E:\file\agent\ai assistant\third_party\sources\dsh-game-daily-main` | `dsh-game-daily` 0.3.0 | https://github.com/gychen-NJU/dsh-game-daily |
| `E:\file\agent\ai assistant\third_party\sources\dsh-minecraft-main` | `dsh-minecraft` 0.12.4 | https://github.com/Ruqii/dsh-minecraft |
| `E:\file\agent\ai assistant\third_party\sources\dsh-minecraft-agent-main` | `@jcs130/dsh-minecraft-agent` 0.3.0-rc.24 | https://github.com/jcs130/dsh-minecraft-agent |

三个清单均声明 MIT，直接复用代码时保留相应版权与许可证，传递依赖另查。本地版本不等于当前上游最新版本，也不等于已兼容本机 Harness。此前网页缓存中的 game-daily 0.1.0 已不适用于这份本地源码。未核实 Git commit，阅读快照指纹见文末。

## 2. 先承接已有实现，避免重做

先读取本项目的现行协议与最新代码：

- [研发进度](<E:/file/agent/ai assistant/docs/progress.md>)
- [桌面动作协议](<E:/file/agent/ai assistant/docs/desktop_action_protocol.md>)
- [PreAct 接口](<E:/file/agent/ai assistant/docs/preact_interface.md>)
- [记忆核心协议](<E:/file/agent/ai assistant/docs/memory_contract.md>)
- [记忆宿主接入](<E:/file/agent/ai assistant/docs/memory_host_integration.md>)
- [当前记忆宿主源码](<E:/file/agent/ai assistant/plugins/dsh-desktop-observe/memory.js>)

截至本次读取，记录显示：记忆四工具已 live；两会话显式写入与读取已有成功证据，但新会话命令结果行展示问题仍待处理。模型只持有 recall/propose/checkpoint/resume，长期事实的显式写入、确认、修订和删除由人类命令进入。

以下三个边界已经补入代码，不应重新实现另一套：

1. 无法确定项目时拒绝 `PROJECT_UNKNOWN`。
2. 召回依赖按用户请求记录，替代整个会话的无差别累积。
3. 删除绑定 `plan_id` / `data_version`，执行时核对计划变化。

按请求记录不自动证明“跨轮摘要的完整依赖”已解决；自动 checkpoint 仍需核对跨请求、恢复摘要与自动注入的依赖传递。现有进度记录的测试数字不是本轮重新运行的结果。

桌面侧已有固定 Medium 执行器、窗口/会话/动作授权、观察绑定、三态验证与内容绑定 proof。保留这些约束，不用游戏插件的执行方式替换。当前单步实机与程序重放证据不能外推成任意软件、多步骤任务均可靠。

## 3. 优先阅读的源码与可迁移设计

### A. dsh-game-daily：运行管理，不是通用视觉模型

阅读入口：

- [lib/runner.mjs](<E:/file/agent/ai assistant/third_party/sources/dsh-game-daily-main/lib/runner.mjs>)：`startRun`、`stopRun`、进程存活判断、运行收尾。
- [automation/run-headless.mjs](<E:/file/agent/ai assistant/third_party/sources/dsh-game-daily-main/automation/run-headless.mjs>)：看门狗、截止时间、兜底报告。
- [lib/report.mjs](<E:/file/agent/ai assistant/third_party/sources/dsh-game-daily-main/lib/report.mjs>)：运行目录、原子文件替换、摘要和历史读取。
- [lib/prompt.mjs](<E:/file/agent/ai assistant/third_party/sources/dsh-game-daily-main/lib/prompt.mjs>)：执行引擎选择、步骤与证据字段、失败汇报。
- [index.js](<E:/file/agent/ai assistant/third_party/sources/dsh-game-daily-main/index.js>)：配置白名单、状态查询、运行对账。

值得迁移：

1. 每次执行有独立运行身份，元信息、步骤回执、验证结果与用户摘要可关联。
2. 正常完成、失败、取消、超时均能收尾；重启后能识别未结束的运行。
3. 设置草稿与真正应用分开，诊断与真实动作分开，用户能看见当前状态并停止。
4. 汇报失败只补写报告，不重新执行已经做过的动作。

本地代码中需要改造而非照抄的点：

- `report.mjs` 的 `newRunId` 只有秒级时间，不足以充当我们的并发唯一标识。使用 UUID 或带随机部分的运行 ID，并另设稳定幂等键。
- `readReport` 读取 JSON，`summaryOf` 提取字段，不等于独立核验任务成功。Agent 写出的 `success` 只能作为声明。
- `run-headless.mjs` 末尾只对 `failed` 返回非零；不能用其退出码区分 partial、aborted、unknown 等业务状态。
- `runner.mjs` 设置 `danger-full-access`，会启动前台守护、关闭其他游戏；这些行为不迁入桌面助手。
- `stopRun` 使用 `taskkill /T /F`。强杀进程树不能证明按键释放，也不能证明最后一个动作未发生。我们的取消必须沿用执行器协议，无法确认时保留未知结果。
- 通过临时文件重命名实现文件替换值得参考，但不能直接等同于多写者事务、幂等提交或崩溃持久性保证。

### B. dsh-minecraft：增量观察与真实动作回执

阅读入口：

- [lib/index.js](<E:/file/agent/ai assistant/third_party/sources/dsh-minecraft-main/lib/index.js>)：工具定义、输入边界、简洁结果渲染。
- [lib/bot.js](<E:/file/agent/ai assistant/third_party/sources/dsh-minecraft-main/lib/bot.js>)：`observe`、`walkTo`、`clearPathing`、`craft`、`dig`。

已读到的关键设计：

- `observe` 带 `since_last_look`，补充两次观察之间发生的事件。
- `walkTo` 有执行超时、受伤中止和停止后的寻路状态清理；返回位置进展与副作用，而不是只返回“工具完成”。
- `craft` 在调用后等待背包变化，没有变化就返回未生效。
- `dig` 跟踪目标掉落物，避免把捡到其他物品误算成当前动作成功。

迁移到桌面助手：

- 观察附带焦点变化、窗口位置/尺寸变化、用户接管、超时与观察失效等有证据的事件；保留来源、时间与观察 ID。不要把猜测的弹窗语义包装成系统事件。
- 分开表示“输入送达”“界面变化”“目标条件成立”。界面有变化也可能是错误弹窗。
- 长动作必须有取消与收尾；收尾后再允许新的动作，不能让旧工作仍在后台发输入。
- 同时记录副作用和已完成步骤，中途停止不声称自动回滚。

不照抄其全局 `journal.splice` 消费模型：我们的多请求/多观察者应使用游标、有限事件缓冲与明确的丢失范围；事件溢出或游标过期时要求重新观察，不能静默假装没有变化。短期事件缓冲也不自动写进长期记忆。

Mineflayer 直接提供游戏状态。这条路线是专用协议适配，不是截图 OCR/VLM。评测报告必须标明使用的是视觉、系统元数据还是专用接口。

### C. dsh-minecraft-agent：会话、执行器与方法库分离

阅读入口：

- [docs/character-notebook.md](<E:/file/agent/ai assistant/third_party/sources/dsh-minecraft-agent-main/docs/character-notebook.md>)：稳定身份、笔记隔离、版本与归档含义。
- [lib/plugins/harness-lifecycle.mjs](<E:/file/agent/ai assistant/third_party/sources/dsh-minecraft-agent-main/lib/plugins/harness-lifecycle.mjs>)：`HostLifecycle`、失败分类、目标激活和运行状态投影。
- [docs/harness2.md](<E:/file/agent/ai assistant/third_party/sources/dsh-minecraft-agent-main/docs/harness2.md>)：隔离练习、baseline/candidate/holdout、任务去重、记忆失败后的 pending。
- 后续按需核对 [harness-goal.mjs](<E:/file/agent/ai assistant/third_party/sources/dsh-minecraft-agent-main/lib/plugins/harness-goal.mjs>) 与 [harness2.mjs](<E:/file/agent/ai assistant/third_party/sources/dsh-minecraft-agent-main/lib/plugins/harness2.mjs>)。本轮未完整审计这两个文件。

值得迁移：

1. 执行器连接状态、模型轮次结束、任务完成、暂停与停止是不同概念。
2. 保存停止意图，重启只恢复可查看的上下文，不擅自重新激活任务。
3. 异常诊断只保留受控错误码与阶段，避免把完整堆栈、路径、模型响应或凭据写进长期记忆。
4. 方法改进在隔离环境比较原版与候选，并使用不同的留出场景；成功产物也不直接覆盖线上版本。
5. 动作已经执行、但记忆写入失败时，重试记忆写入，不能为补记忆重跑动作。

注意：其文档允许 Agent 直接记游戏笔记，也允许外部记忆插件与核心笔记并存。本项目不继承这些写权限或多存储设计，仍以现有 SQLite MemoryGateway 为记忆真源。其归档保留历史，不等于本项目 forget 的擦除语义。

当前插件的游戏核心属于独立 `agent-mc-world` 依赖，不能因为下载了适配器就声称已经审阅核心。Harness² 文档部分版本说明是历史阶段记录，不能直接作为本地发行版的验收结论。

## 4. 建议的实施顺序

以下名称和字段是建议契约，实施前先对照现有结构，优先增量扩展，不另造一套平行框架。

### 第一步：统一运行记录与停止语义

先接现有单步/重放入口，不急着做计划任务或新设置页面。

建议将以下事实分别保存：

| 字段组 | 含义 |
| --- | --- |
| `task_id / run_id / request_id / operation_id` | 任务、单次运行、请求和幂等操作身份，由宿主产生 |
| `scope / policy_version` | 稳定用户/项目范围与本轮策略版本 |
| `lifecycle` | queued/running/waiting_user/stopping/ended，描述生命周期 |
| `termination_reason` | completed/cancelled/timeout/error/interrupted，不代替验证结论 |
| `input_delivery` | not_sent/sent/unknown，记录真实输入事实 |
| `verification` | passed/failed/unknown，关联具体步骤、观察和验证器版本 |
| `checkpoint_write` | pending/saved/failed/skipped，不影响已完成动作的事实 |

最终成功仅在所需步骤和目标条件均有有效验证时成立。退出码为零、模型 final、报告存在都不独立满足这一条件。重启看到未收尾记录时先核对执行器，不能自动重跑。

桌面输入采用宿主执行租约/互斥，至少跨进程保证同一桌面不能被两个任务同时操控。不要通过关闭用户其他软件解决竞争。焦点丢失或用户接管时暂停，重新观察并检查授权后再继续。

### 第二步：接任务边界的自动 checkpoint

沿用此前决定：按项目一次开启，支持暂停及本次不保存。自动保存工作进度不等于允许保存完整聊天、截图或自动画像。

- 触发来自真实任务边界/稳定进展，不能把每个工具回合当任务结束。
- 使用模型/工具真实来源保存摘要，不把模型总结冒充最后一条用户消息。
- 依赖由宿主收集，覆盖实际提供给摘要的记忆及恢复摘要的传递依赖；不能只靠模型申报。
- 相同结束事件去重；同一任务更新 checkpoint 时使用最新版本比较，避免重试产生重复或覆盖新进展。
- 超时后先核查持久化结果，再重试写入。没有原子幂等写入能力时先补协议，不用新 ID 盲重试。
- 用户取消后不再启动新的总结推理；如已开启中断保存，仅保存已有进度。
- 保留 `context_only`、`execution_authority=false`、`requires_fresh_observation=true`、`task_success_verified=false`。

### 第三步：增量观察与受限自动检索

先提供有界事件摘要；自动检索只在真实用户请求需要历史信息时触发。优先 current，必要时限量 search，自动路径不带候选或 history。每次注入可替换，不能逐轮无止境累加。

“本地保存”与“发送给当前模型服务”应在项目开关中说明。范围不明不检索，故障与无匹配分开；依赖记忆才能确定的动作参数，缺失时先停止澄清。

更正、撤销、过期、删除应使所有相关会话缓存、待发送请求和派生摘要失效。已发送的上下文不能追回；旧消息仍在上下文中时，要重建上下文或开启干净会话，不能声称已从模型端擦除。

### 第四步：完善 PreAct 的隔离比较，再考虑自动整理

参考 Harness² 的比较思路，暂不引入它的整套运行依赖：固定原程序与候选程序，使用不同窗口尺寸/位置、相似弹窗等留出场景复测，记录失败证据与精确版本。图像模板通过仍受语义边界限制。

候选方法不直接改线上程序；继续通过本项目 proof 和验证链路晋升。行为轨迹、程序库、用户偏好是不同对象，不能通过 memory_propose 或 checkpoint 绕过程序证明。

自动 promote 普通记忆仍关闭。保留策略先做过期和预览，过期不等于擦除。不能循环对过期候选调用当前 forget：共享来源和派生关系可能级联删除有效偏好。任何自动擦除必须检查整个删除计划均在已批准范围内。

## 5. 最小验收清单

先用离线假执行器和虚构记忆做有意义的回归；无须为了阅读参考运行第三方游戏测试。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 重复投递同一结束事件 | 一个逻辑 checkpoint，不重复动作 |
| 动作已执行、调用超时 | 保留 unknown/实际输入阶段，不自动重试点击 |
| 保存已提交但回执丢失 | 查询/幂等重试取回原结果，不新增重复版本 |
| 两个任务竞争桌面 | 只有一个持有执行租约 |
| 停止后立刻提交新动作 | 旧执行器未确认停止前拒绝新输入 |
| 用户抢回焦点 | 暂停，不强制抢回，不关闭其他程序 |
| 进程退出但无最终报告 | interrupted/unknown，不能认定任务成功 |
| 模型报告 success，验证器 unknown | 不晋升程序，不报告已验证成功 |
| checkpoint 依赖的偏好被更正/删除 | 旧摘要不再默认恢复，跨会话也失效 |
| 记忆写入失败 | 只补写记忆，不重跑动作 |
| 事件缓冲溢出/游标过期 | 明确缺口并重新观察 |
| 过期候选共享有效偏好的来源 | 清理预览揭示影响，不能越范围自动擦除 |
| 重启前用户已暂停 | 重启后保持暂停，不恢复动作授权 |

离线通过后，只在用户已授权的计算器/记事本测试窗口验证需要的场景。付费调用沿用会话现有授权，不因本参考文档自行增加后台模型、游戏实验或新服务。

## 6. 给 DeepSeek 的执行交付要求

1. 先对照当前代码列出“已有/缺失/本轮实现”，不要重写已完成的三项记忆边界修复。
2. 第一轮交付聚焦运行生命周期、幂等收尾以及自动 checkpoint 的宿主接口；后续增量观察和自动检索分批接入。
3. 明确实际使用的 Harness hook、事件字段和任务边界，以已安装代码为准，不从其他插件版本猜 SDK。
4. 保留 RAG 与现有 Python 环境；不安装 CUDA，不自动启动下载源码的入口、计划任务、提权助手或游戏。若确需新依赖，再核对版本与兼容性。
5. 区分代码实现、离线验证、Harness live 加载和真实桌面验证。已有记录中的“通过”不能当作新增功能的验收。
6. 记录采用的参考文件、关键差异与验证证据，保留许可证。清理自己创建的临时测试数据，不清理正式记忆、proof 或用户下载源码。

## 附：本地阅读快照 SHA-256

以下路径均相对 `E:\file\agent\ai assistant\third_party\sources`，用于识别本次读到的文件，不代表完整仓库签名。

```text
dsh-game-daily-main/package.json
E42A04D39A4A16FD65602C62AC1B1B949C39A39D0FB5CBA5E880AA15FDC17F02
dsh-game-daily-main/lib/runner.mjs
1644F5B98382BBBB2A590CF5D777AAE7A3D2F703F3CB8BBB8FC649506FC2E68C
dsh-game-daily-main/lib/report.mjs
24BBB1B19BDC052A3C9F09CA9F624134AEAFF3E0D953A07DD34DED437748A37C
dsh-minecraft-main/lib/bot.js
FA13D2849BB955EAEFFCF0834404BEBF998825B0C89CA7A203D7503493A9A0CA
dsh-minecraft-agent-main/package.json
98F633BC4E9CC6A1929B6F618B2B86E14AAEBEA121D61C50BA9308B113FA4DD2
dsh-minecraft-agent-main/lib/plugins/harness-lifecycle.mjs
BF1FABCC13DD6F0258F3E201B51669A604699D4CEC3FD5F3ABDFF21390170576
```
