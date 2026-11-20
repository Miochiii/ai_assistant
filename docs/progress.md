# 桌面助手研发进度

- **常驻 Host RH04 观察核心（2026-11-03）**：新增 `observation-service.js`、`mss-adapter.js` + `capture_once.py`、`mss-observation-runner.js` 和 `see-now-adapter.js`（无 ffmpeg 明确拒绝）。ObservationService 已注入 Host：resume 启动连续抓帧，pause 清 timer 和 latest，采集失败进入 fault；mss 本地帧差支持低变化丢弃。复用 See Now Apache-2.0 `cuts.js`/`scale.js`/`png.js`（vendor）做 HSV 64×36 变化分、8 邻域聚类、小区域过滤和 320×180 缩略图；新增 `scene-wake.js`、`wake-model-adapter.js`、`preact-gate.js`、`action-request-bridge.js`、`exploration-flow.js`、`program-draft.js` 和 `scripts/preact_draft_verify.py`：新帧节奏/模型建议/授权闸门/探索授权/风险授权/验证后录制/PreAct draft/新观察重放与 proof 路径；全部不自动执行动作，draft 不冒充 verified。8 项观察 + 4 项 Host 观察 + 3 项 runner + 6 项帧分析 + 5 项 scene-wake + 5 项步骤循环 + 6 项 wake-model + 5 项 PreAct gate + 4 项 action bridge + 5 项 exploration flow + 4 项 program draft 测试通过；离线 `verify_program` 2 项 proof 测试通过；**live** Notepad draft replay 已完成 1 次点击/3 事件、B03 验证通过并生成 HMAC proof，随后 `inventory.save_program` 入库并由 `load_program` + `verify_proof` 复核；多步 `notepad-file-menu-toggle` live 重放在第 2 步 closed 模板验证失败（0.937414 < 0.98），未生成 proof/未保存；新增 DSH 会话模型端口（sessionController/attachments/session-event 收集 assistant 文本）和 See Now 风格 speech bus（due/spoken，接口预留、无 TTS 引擎），Host 已支持可选 speechPort；新增 `/assistant-model-check`（抓一帧、附图异步 followup、session/event 收回复）、`/assistant-model-status`、`/assistant-open`/`/assistant-close`（显式启动/关闭紧凑面板）和 `/assistant-model-watch`/`stop`；模型回复改为结构化 `{speak,text,reason}`，`speak=false` 不写面板/语音；新增 `candidate-gate.js`：本地变化分/比例/区域门控、8 秒冷却、连续静默指数退避（不再自动停）、强变化新场景重置退避；`/assistant-model-watch [秒]` 可调扫描间隔；自定义面板菜单替换原生 tk_popup 修闪烁；`/assistant-open` 默认不再启用 WDA 截图排除（该机器上排除会让面板不可见），实测不带排除时 Tk 面板可见；新增 `panel-model.js`：面板输入通过 companionStream 走独立短上下文模型请求，不进入主会话；新增 `highlight-controller.js` + `highlight_locator.py`：指导回复中的 `[[HIGHLIGHT:目标]]` 经本地 OCR 定位后由 Coach Overlay 只读高亮；面板指导会自动建立单步任务，检查步骤时用新截图交独立模型返回 passed/failed/unknown，通过才清高亮并完成任务；本地从“教我点击‘新会话’”等句子推断目标，模型不再因为没有画面而反问，并可在反问回复时回退为直接指导；199 项 Node 测试通过；真实 `/assistant-model-check` 已在用户 DSH 会话中成功收到模型画面描述（用户实测）；结构化 JSON 与 `/assistant-open` 已由用户现场验证；角色卡/自动记忆候选仍未接；TTS 仍未接。真实 mss/窗口 geometry/WDA 捕获排除通过。证据 `results/assistant-host/rh04-observation-offline.json`、`results/preact-draft/notepad-open-file-menu-v3-draft-20261103T151946Z.json`、`runtime/programs/notepad-open-file-menu-v3-draft/v1.json`、`log/2026-11-03-rh04-observation-offline.md`。

- **常驻 Host RH03 紧凑界面（2026-11-03）**：`resident_compact.py` 替代大面板与独立鲸鱼窗：560×64 蓝粉玻璃输入条、两条透明消息气泡、任务行、原生 Entry，主高亮层不再创建；面板/feed 两个窗口均 `WDA=0x11`，`--exclude-capture` mss 截图已无助手窗口。`test_resident_compact.py` 4 项、Node Host/UI 19 项、旧布局 4 项通过；截图 `results/vision/resident-compact-real-visible.png`、`resident-compact-task-chat.png`。真实键盘/IME 和混合 DPI 未验证。证据 `results/assistant-host/rh03-resident-panel.json`、`log/2026-11-03-resident-blue-pink-glass.md`。
- **常驻 Host RH01–RH02 离线底座（2026-11-03）**：新增 `plugins/dsh-assistant-host`，实现状态/任务/epoch 生命周期、`inbox/acks/outbox/state.json` 文件通道、单实例锁、原子写入、event ID 去重和离线 `/assistant-check`。不改旧 Overlay/Coach Host，不接模型、截图、输入。`node --test` 17 passed；离线检查 19 项通过；证据 `results/assistant-host/rh01-baseline.json`、`results/assistant-host/rh02-offline.json`、`log/2026-11-03-rh01-rh02-offline.md`。

## 2026-10-30 · live checkpoint 修正与 replay 自动 checkpoint 接入

- 用户已启用项目 scope、30 天、`auto_checkpoint=1`、`auto_recall=0`。
- **首次 live click 部分成功**：run `f8c58da3...` 写入 saved checkpoint `ec79ed21...`，但 `action.js` 读取了不存在的 `input_delivered`，导致 `input_delivery=unknown`、facts 为空。已修 `action.js`/`preact_replay.py` 的 `input_delivery_observed` fallback。
- **修正后 live click 通过**：run `ed1903b1...` 写入 memory `46e01782...`，`input_delivery=sent`、facts 一条、来源 user/tool 分离、resume active、`automatic_execution=false`、`task_success_verified=false`。重启后第三次 click run `0c373e11...` 写入 `19f3806b...`，仍正确。
- **replay 自动 checkpoint 已通过**：v4 replay run `9ef78d59...` 完成 2 steps/2 receipts、`memory_context_available=true`、`checkpoint_facts` 两条、`input_delivery=sent`、`checkpoint_write=saved`、memory `01b067a6...`；resume active、`automatic_execution=false`、`task_success_verified=false`。
- 之前 replay 失败的根因是 `replay.js` 把 `requireSession()` 字符串传给 `memoryRuntime.context()`，而 `runContext` 需要 `exec.agent.session` 对象；异常被吞成 null。已改为对象并加 Node 测试。
- 修复 `preact_replay.py` 把不支持的 `checkpoint_write` 传给 `RunLedger.start` 导致的 TypeError；无授权诊断能正常写 `AUTHORIZATION_REQUIRED` run 且 0 输入。
- **新会话恢复通过**：用户在真实新 Harness 会话执行 `memory_resume program:notepad-file-menu-toggle:v1`，读回 memory `01b067a6...`、run `9ef78d59...`，`task_success_verified=false`、`execution_authority=false`、`automatic_execution=false`、`requires_fresh_observation=true`。
- **旧错误 checkpoint 已由用户显式清理**：`ec79ed21...` 已不存在；当前余 3 个正确测试 checkpoint。
- **只读状态核对**：激活 `test.txt` 并截图一次（0 click/0 input），观察 `7af16d37...` 显示 File 菜单处于关闭状态、文本未变；这是一张当前快照，不是历史任务成功证明。
- **C1 离线基础与 live promotion（旧设计，已被下条修复）**：新增 `memory_context_exposures`/`memory_context_states`，只存 memory ID/版本、session/request/generation、状态，不存正文；`register_exposure`/`promote_exposures`/`context_state`/`invalidate_context`；revoke/forget 自动把受影响暴露标为 invalidated、上下文标为 needs_refresh；`context_state` 检查撤销/删除/到期。原实现在 `llm/stream` needs_refresh 时拒绝放行，已由下方 2026-11-01 修复改为非阻塞。
- **C1 上下文失效恢复修复（2026-11-01）**：新增 `context_generation` / `refresh_context`，host 从核心恢复 generation，`/memory refresh` bump 到新 generation 并写 audit；`llm/stream` 不再因 needs_refresh 中断 `next()`，记忆工具错误转成结构化 `error_code/message/recovery`；`context_state` 的 `rebuilding/blocked` 仅保留为 legacy schema 预留。修复了 forget 后整段会话被 UNKNOWN 炸掉的问题；Python **221**、Node **93**、host 单测 **13**；真实 host 检查 15 通过。证据 `results/memory/context-recovery-fix-20261101.json`。
- **Win32 文本接收器延迟选区探测（2026-11-02）**：action-ready 观察由低完整性进程采集，对 Medium Notepad 的 `EM_GETSEL` 返回 access denied，旧逻辑把标准 `Edit` 误判为 `supported=false`。现观察侧保留 class/style 能力并标 `selection_probe=unavailable`，执行器在 Medium 侧强制当前 `selection_collapsed=true` 后才输入；同时扩展标准 `RichEdit*` 类。Notepad 标准 Edit live 通过：输入 `能力验收abc`、14 事件、可见文本、第 8 列、未保存/无 Enter。证据 `results/executor/text-receiver-deferred-probe-20261102.json`；Python **236**、Node **93**。
- **Coach Host OCR 语义定位（2026-11-02）**：`coach_host.py` 新增 `--locator auto|ocr|patch`，OCR 走 Windows 内置 `Windows.Media.Ocr`（`zh-Hans-CN`），`ocr_windows.ps1` 在低完整性进程下用 in-memory WinRT stream 解码 PNG，避开 `StorageFile` broker 失败。Plan 只需 `target: "新会话"/"插件"`，不再需要 reference/bbox。实测 DSH：第 1 步 OCR `新会话` → `[475,256,108,36]`；Next 后 fresh capture + OCR `插件` → `[346,328,93,38]`，state generation 2，鲸鱼 `STEP 2/3`。patch 仍作为 fallback。无目标输入。证据 `results/executor/coach-host-ocr-20261102.json`、`results/vision/coach-host-ocr-step1.png`、`coach-host-ocr-step2.png`。
- **Coach Host 闭环 PoC（2026-11-02）**：`coach_host.py` + overlay `--event-file/--host-paced`。鲸鱼“下一步”写 `next_requested`；Host 重新截图、重定位、写 state。patch 版本实测“新会话”→“插件” similarity `1.0`。证据 `results/executor/coach-host-patch-20261102.json`、`coach-host-step1-visible.png`、`coach-host-step2.png`。
- 全量：Python **236**、Node **93**；记忆自动化/账本 **22**、核心 CLI 宿主 **15** 通过。
- 证据 `results/memory/context-recovery-fix-20261101.json`、`results/memory/checkpoint-cleanup-20261101.md`、`results/executor/text-receiver-deferred-probe-20261102.json`、`e2e-two-input-20261101.json`、`e4-drag-live-20261101.json`、`e4-drag-20261101.json`、`e3-combo-live-20261101.json`、`e3-combo-20261101.json`、`e2-two-input-focus-20261101.json`、`e2-text-live-qq-20261101.json`、`e2-text-live-qq-blocked-20261101.json`、`e2-text-20261101.json`、`e2-key-live-20261101.json`、`e2-key-20261101.json`、`e1-scroll-live-20261101.json`、`e1-scroll-20261031.json`、`results/memory/context-gate-live-20261031.json`、`context-exposure-c1.json`、`new-session-resume-20261030.json`、`replay-checkpoint-live-20261030.json`；测试 checkpoint 曾清理为 0，随后 Notepad 验收产生 2 个测试 checkpoint。
- **GPT 决策已接收（2026-10-30）**：当前只采用显式 recall/resume + 失效时干净上下文回退；`auto_recall` 继续关闭；已启用的 `auto_checkpoint` 与 30 天期限保持不变。下一阶段按 C1 做暴露登记/失效闸门，再 C2 干净切换、C3 surface 重建；见 [决策日志](log/2026-10-30-memory-context-invalidation-and-surface-decision.md) 与 [上下文审计](docs/memory_context_hook_audit.md)。
- **Grounding 第二线决策已读**：只保留 `locator` 注入和完整观察证据；不安装检测器、不发图片请求、不启用候选编号；第二条线等第一条线成熟后再独立实验。见 [接口计划](log/2026-10-30-grounding-second-track-interface-plan.md)。
- **统一输入协议决策已接收（2026-10-31）**：只扩展固定执行器内的有类型动作，不开放任意 SendInput/脚本；一次请求一个语义动作，不跨请求持键；fail-stop、尽力释放、不做通用回滚；delivery/receiver/verification 分离；顺序 E0 基础 → E1 滚动 → E2 导航键/短文本 → E3 组合键 → E4 拖拽。当前只是设计，键鼠/文本/滚动/拖拽均未实现。见 [协议评审](log/2026-10-31-unified-input-protocol-and-failure-review.md)。
- **E0 第一/第二/第三切片（2026-10-31）**：拆出 action/observation/receipt schema 常量（值仍为 1，兼容旧 click）；Node 启动器每次执行无条件建立取消通道，超时/stdout 超限请求取消并等待退出；Python ActionClient 改为带取消文件的 Popen、宽限后强杀并报 unknown；新增 operation journal，输入前登记 operation_id/digest，输入前标 input_started，结束后 finalized/unknown/refused；默认输入租约改为用户级共享，跨项目入口共用一把锁；click receipt 增加 release 状态和 pending_or_possible_down。未新增输入类型。尚未完成键盘持键释放、journal 清理策略和 live 验收。证据 `results/executor/e0-foundation-20261031.json`。
- **E1 有限纵向滚动（2026-10-31）**：action contract 只接受 vertical、notches -3..3；executor 用观察锚点、单次 wheel、显式 scroll grant；旧 click grant 不授权 scroll；默认 grant 仍不含 scroll；receipt 报 `input_api_accepted`、`input_delivery_observed=false`、无按钮释放声明。`desktop_scroll` 工具已注册并通过 Node/原生 schema 检查，使用同一 run ledger/自动 checkpoint 路径。证据 `results/executor/e1-scroll-20261031.json`。
- **E1 live PDF 滚动（2026-11-01）**：Edge PDF `hwnd=657844`，单次 vertical `-1` notch；wheel 接受 1 次、input_events=2、画面变化 0.073081；动作前后截图显示正文上移，仍为 255/318；无 click、无重试。run `bcf94d2a...`、checkpoint `ff2ce8d1...` saved；任务成功仍为 false，接收器效果来自可见截图，不宣称 PDF 完整渲染或任务完成。授权已撤销。测试中发现并修复了 `desktop_click_trial.py` 对含 U+200B 标题的 GBK 输出异常（改为 `ensure_ascii=True`，未造成输入）。证据 `results/executor/e1-scroll-live-20261101.json`。
- **E2 导航键 core/tool（2026-11-01）**：observation binding 新增 host-captured focus evidence；executor 只接受 Left/Right/Up/Down/Home/End，要求 active/focus/root HWND 一致且显式 key grant；Win32Desktop.press_key 发送一次 keydown/keyup 并记录 release；`desktop_key` 工具复用 run ledger/自动 checkpoint。证据 `results/executor/e2-key-20261101.json`；当前 9 个桌面工具 schema 通过。
- **E2 live PDF 导航键（2026-11-01）**：焦点 `active/focus/root=657844`；单次 `Down`，key events 2、input_events=3、画面变化 0.113225，PDF 正文移动到后续题目；run `fea2d944...`、checkpoint `c48d1f03...` saved；无 click、无 text、无重试，任务成功仍 false。回执曾把完整批次误标 `key_release=unknown`，已修正为完整 2 事件即 `observed_neutral`，未重发按键。授权已撤销。证据 `results/executor/e2-key-live-20261101.json`。
- **E2 短文本 core/tool（2026-11-01）**：text 契约限制 1–16 Unicode scalars、最多 32 UTF-16 units，拒绝 CR/LF/Tab/控制字符；焦点证据和显式 text grant 必需；Win32Desktop.insert_text 以 UTF-16 keydown/keyup 对分批发送，部分批次做有限 keyup 清理；receipt 不保存正文，operation digest 绑正文哈希；`desktop_text` 工具复用 run ledger/自动 checkpoint，UI 展示 redact 文本。证据 `results/executor/e2-text-20261101.json`。
- **QQ 文本实测被阻断（2026-11-01，已解决）**：旧 Node ACTIONS 白名单不含 text，含 text 的 grant 被判无效，`desktop_activate` 返回 AUTHORIZATION_REQUIRED；0 点击/0 输入/0 文本。已加入 text 白名单和授权回归测试。证据 `results/executor/e2-text-live-qq-blocked-20261101.json`。
- **E2 live QQ 文本插入（2026-11-01）**：QQ `hwnd=67422`（千坂）；第一次点击被 `INPUT_CHANGED` 拒绝，0 输入；重新观察后点击输入区送达，光标可见；重新观察后 `desktop_text` 插入 `测试输入abc`，7 scalars/14 key events，输入框显示该文本，**未按 Enter、未发送消息**。run `e830cdb9...`、checkpoint `399fe9d1...` saved；任务成功仍 false。焦点证据只是顶层 HWND，不能证明任意多输入框定位；接收器验证是可见截图。授权已撤销。证据 `results/executor/e2-text-live-qq-20261101.json`。
- **E2 双输入区焦点切换 + 可见文本验证（2026-11-01）**：本地 `two-inputs.html`，同一边缘窗口 `hwnd=525416`；先发生一次预览坐标误用（Field A 上方），API 接受但画面无变化，未计成功；用原图坐标重新定位后 Field A=`AAA`、Field B=`BBB`，焦点边框切到 B。`desktop_text` 新增 `receiver_verification.status=visual_review_required`，本次人工/模型视觉记为 `visually_observed`；未做 OCR/UIA，未宣称确定性文本验证。无 Enter、无表单提交；授权已撤销。证据 `results/executor/e2-two-input-focus-20261101.json`。
- **E3 受限 Ctrl+方向组合键 core/tool（2026-11-01）**：只接受 `Ctrl+Left` / `Ctrl+Right`；显式 `chord` grant、focus/foreground 检查、4 事件完整批次、部分批次有限释放；新增 `desktop_combo` 工具，复用 run ledger/自动 checkpoint；默认关闭，不接受 Ctrl+A/C/V/X、Alt/Win/Shift、文本或 Enter。证据 `results/executor/e3-combo-20261101.json`；10 个桌面工具 schema 通过。
- **E3 live Ctrl+Left QQ（2026-11-01）**：QQ `hwnd=67422`，输入框已有 `测试文本abc`；点击文本末尾后发送一次 `Ctrl+Left`，4 个 chord 事件接受、完整释放，`chord_release=observed_neutral`；放大截图显示光标从 `abc` 末尾移动到 `本|abc`，文本未变；无 Enter/发送。run `2bb68f5d...`、checkpoint `c63d5972...` saved；任务成功仍 false。授权已撤销。证据 `results/executor/e3-combo-live-20261101.json`。
- **E4 同窗口受限拖拽 core/tool（2026-11-01）**：只允许同一授权窗口内一次左键拖拽；start/end 来自同一观察，距离≥8；执行器预检所有插值点、12 步移动、按下/释放完整批次；部分批次有限释放，不重试；新增 `desktop_drag` 工具，显式 `drag` grant，复用 run ledger/自动 checkpoint。证据 `results/executor/e4-drag-20261101.json`；11 个桌面工具 schema 通过。
- **E4 live 文本选择拖拽（2026-11-01）**：本地双输入测试页 `hwnd=1901248`；从说明文字左端 `[125,405]` 拖到右端 `[1120,405]`，1 次按下、12 步移动、1 次释放，15 个事件，`release=observed_neutral`；截图确认整段文字高亮选中，未拖文件/窗口、未跨窗口、未重试。run `2937176f...`、checkpoint `0829224f...` saved；任务成功仍 false，Edge 选择工具条是释放后的应用侧效果。授权已撤销。证据 `results/executor/e4-drag-live-20261101.json`。
- **端到端组合小任务（2026-11-01）**：本地双输入页 `hwnd=1901248`；观察 → 点击 Field A → 输入 `Alice` → 重新观察 → 点击 Field B → 输入 `Bob` → 重新观察 → 拖选说明段落；最终截图为 A=`Alice`、B=`Bob`、段落高亮。无 Enter、无提交、无发送、无自动重试；各步均重新观察并使用新 binding。视觉等级 `visually_observed`，`task_success_verified=false`；授权已撤销。证据 `results/executor/e2e-two-input-20261101.json`。

## 2026-10-29 · desktop_replay 自动 checkpoint 任务边界 · 离线

- 首个 `desktop_click` 之外的任务边界接入：`preact_replay.py` 用宿主提供的 memory context 启动 run ledger，写入 `checkpoint_write=pending`、`memory_context`、`executor_state=stopped` 和逐步 `checkpoint_facts`；结束后 Node `replay.js` 调用宿主 `autoCheckpoint(session,{run_id})`，刷新 run record。
- memory context 只由 Node 宿主 `memoryRuntime.context` 构造，经子进程环境传入；Python 校验 scope、session、request/user/consent/source 字段，malformed 或 session 不匹配时退回无自动记忆，不伪造来源。
- `desktop_replay` 没有启用正式自动化开关；本轮仅离线/单测，不写真实项目记忆、不调用模型、不执行桌面输入。当前运行中的 Node 插件需重启才加载 replay 集成。
- 全量：Python **198**、Node **78**；记忆自动化/账本专项 **22** 通过；`check_memory_automation.py` 通过。新增 replay memory context + facts 测试、Node autoCheckpoint 刷新测试。
- **首次 live checkpoint（部分成功，不验收）**：用户已启用项目 scope、30 天；对 `test.txt` 空白点击一次，run `f8c58da3...` 的 `checkpoint_write` 为 `saved`，memory `ec79ed21...`。但 `action.js` 读取了执行器不存在的 `input_delivered`，导致 run 的 `input_delivery=unknown`、facts 为空，尽管实际 `input_events_sent=3`/`input_delivery_observed=true`。已修 `action.js`/`preact_replay.py` 的字段 fallback 并加测试；当前运行中的 Node 仍旧代码，必须重启后再做一次 fresh run。证据 `results/memory/live-first-checkpoint-20261030.json`。

## 2026-10-29 · 用户改由 DeepSeek 继续 · 本代理现场收尾

- 已停止应用操作。用户已同意的临时项目/30 天/test.txt 一次低风险点击/第二会话恢复后关闭范围尚未写成 Harness 设置；本代理未启用正式自动化、未执行 test.txt 点击、未新增现场 run/checkpoint。只读正式库确认仍无启用记录，未写关闭配置或覆盖用户后续设置。
- 已定向清理先前 Node 测试遗留的合成 `action-test` grant（假 hwnd=1/pid=2），真实授权保留。证据 `results/memory/field-trial-cleanup-20261029.json`。最后 UI 回读输入框仍为空，没有提交命令/消息。
- 已通过的 0.6.5 实现及证据保留，不需为清理重启。后续执行状态见 `log/2026-10-29-field-trial-stopped-and-cleanup.md`；现场验收仍待用户直接在 DeepSeek 中继续。

## 2026-10-29 · 用户报告重启 · 只读核对与上下文入口审查

- 已发现运行中的 Harness 窗口，profile 链接仍指向本项目 0.6.5 源码；尚无运行中版本的直接命令证据。Computer Use 状态读取先后遇到应用授权超时和 `FrameArrived timed out`，无输入，现场验收未通过。mode=ro 检查正式库：本项目尚无自动化设置，保持关闭；启用范围/保留期选择已发给用户。
- 独立核对第二批真实入口：`systemPrompt.context` 支持带 `runtime-context` 来源、`interpolate:false` 的数据贡献，未把记忆放入 system/developer。原生 AgentLoop 的三次假模型请求证明清贡献后旧正文仍在后续请求历史中；需先处理上下文重建/新会话方案，再接正式自动注入。证据 `results/memory/context-hook-audit-20261029.json`，说明 `docs/memory_context_hook_audit.md`。
- 本轮未改运行中插件代码，不需再次为接口审查重启；0 网络、0 付费模型请求、0 桌面输入。现场待继续项见 `log/2026-10-29-restart-readonly-and-context-hook-audit.md`。

## 2026-10-29 · 记忆自动化第一批 · 点击子任务离线实现

- 依照 `log/2026-10-29-memory-automation-and-executor-review-decision.md`，实现项目级人类同意设置、事务内重查、账本终结触发、稳定 operation、原子来源/检查点提交、有限存储重试、到期预览和缺失证据提示。磁盘插件更新为 0.6.5，模型记忆工具仍为四个。
- 首版接 `desktop_click` 的真实账本子任务边界；`desktop_replay` 现已离线接同一 run ledger/memory context（见上方新增条目），但尚未 live。普通聊天/自动检索注入未连接。
- 正式开关未启用，运行中插件未重启，真实两会话验收未做。自动检索/注入未实现。下一步是用户选择范围/期限后的加载与代表性两会话现场测试；未选择则保持关闭。
- 验收与文件说明见 `docs/memory_automation.md`；证据 `results/memory/auto-checkpoint-offline.json`、`host-integration.json`、两份 `*-regression-20261029.txt`、`dsh-memory-contract.json`。全程 0 模型请求、0 桌面输入，不改 RAG 环境。Windows 受限测试的 DLL/私有目录问题在普通本机权限下消失；修正一项仍按两工具计数的旧回归断言，39 个本轮空临时目录已定向非递归清理。
- 最终回归：Python **198**、Node **78**；自动化/账本专项 **22**（包含于 Python 全量），真实核心 CLI 宿主隔离验收 **14**；原生 schema/注册检查通过。这些均为离线开发验证。

## 2026-10-25 · C01–C03 · 记忆核心 v1 基线完成

- 按用户授权，由本轮实现核心；本地参考 dsh-memory-evolve 0.1.0、Mem0 2.2.1、LangMem 0.0.30 和 LongMemEval 源码/评测说明。未安装其依赖或启用自动写入，参考文件指纹见 `docs/memory_handoff.md`。
- 交付 `src/assistant_memory/`、`scripts/memory_cli.py`、`scripts/check_memory_core.py`、`tests/test_memory.py`、`docs/memory_contract.md` 和交接文档。数据库独立于 A03、RAG 和程序库存；本轮未创建真实用户记忆库。
- C01：来源/候选/激活/撤销/删除、作用域、有效时间和版本关系；C02：显式写入、修订、来源、删除、事务持久化；C03：当前/历史/字面检索、无需记忆路由、重建索引。C05 的来源解释结构已实现，但整个 C05 仍待 C04 接入后验收。
- 验收：`.venv` Python 3.14.9 / SQLite 3.50.4，27 项通过；包括两个进程竞争修订、写入中断回滚、未来生效、删除后重开/重建不复活、派生摘要失效、上下文预算与 CLI 往返。报告 `results/memory/core-v1.json`，含代码 SHA256。仅本地开发回归，不冒充官方 LongMemEval 或模型回答质量。
- 首轮测试遇到 Python 私有临时目录 ACL 问题及测试连接未关闭；已改为继承工作区权限的 UUID 测试目录并正确关闭连接。本轮遗留的 20 个测试目录已清理；正式测试数据库也已自动清理，结果报告保留。
- 限制：可信本地宿主 API，不是独立鉴权服务；字面搜索，无模型提取/向量召回；只支持按顺序追加有效时间版本；经历结果暂为 unknown；不签发执行权限、不操作桌面、不修改程序 proof。删除不涵盖 Harness 历史、已有事件库或用户导出。
- 下一步由 Harness 薄适配提供真实事件身份、显式写入意图和请求前上下文注入；先用两会话 A→B→历史→删除验证。C04/C06、QQ 和自动人格更新仍未完成。

## 2026-10-26 · 记忆核心宿主接入 v1

- 核心 `src/assistant_memory` 未重写；重新跑离线验收，**31 项通过**（新增删除计划绑定和幂等 checkpoint 测试），报告 `results/memory/core-v1-rerun.json`。
- 新增宿主薄接入：`plugins/dsh-desktop-observe/memory.js` + `memory-client.js`，通过包内 `memory-host` 行加载（`cordis.patch.yml`），不修改 profile 的 package.json，不新增第二套存储；数据库固定 `runtime/memory/memory.sqlite3`。
- Scope：本机 `local-user`；项目用 `session.header.cwd` 的 realpath SHA-256 前 24 位，不采用模型给路径。来源只接受真实 `user/message`（`source.kind=user`），稳定 ID 由 session+message id 哈希；空文本/超 16000 字符不落库。
- 模型只有四个工具：`memory_recall`（显式 route，结果 `context_only`/`execution_authority=false`）、`memory_propose`（只生成候选）、`memory_checkpoint`（工作上下文，不是成功）、`memory_resume`（要求重新观察、不自动执行）。没有模型 remember/confirm/revoke/forget。
- 人类 `/memory` 命令是唯一显式写入入口：remember/confirm/revise/revoke/plan/forget/recall/checkpoint/resume；forget 需 `confirm:true`，返回 `external_copies_erased=false`。命令 `recordInput:false`，宿主自己记录来源。
- 记忆不拼进 system prompt；只有工具结果以明确 data 标记进入模型，避免把记忆当指令。静态 prompt 只说明 recall/propose 与人类写入。
- 离线验收：`node scripts/check_memory_host.mjs` **10 项通过**（propose 候选、确认、第一/第二会话 recall、history、checkpoint 依赖、resume、auto checkpoint 幂等、plan/forget、删除后为空）；`scripts/check_dsh_memory.mjs` 四工具+命令 schema/注册通过；Node **43**、Python **179**。
- 证据：`results/memory/host-integration.json`、`results/memory/dsh-memory-contract.json`；说明 `docs/memory_host_integration.md`。
- **重启后 live 验证**：四个记忆工具已出现；`memory_recall` none/current 正常，`memory_propose` 生成候选但 current 不返回，history 显示 candidate+真实用户来源；`memory_resume` 对不存在 task 返回 fresh-observation/no-auto-execute；测试候选 `test.memory_host_live` 已用核心管理入口 plan/forget 删除，`export` 为空。记录 `results/memory/live-host-20261026.json`。
- **两会话 live**：A `cmd-09089916-3` `command/done` 为 `Remembered 93ec5f58-...`；B `cmd-09089916-4` history `command/done` 返回 `目录A`/active；当前会话 `memory_recall` 也返回同一条；跨会话 scope 正常。但两个新会话 UI 没有显示 detached command 结果行；命令持久化成功，展示原因未查清。证据 `results/memory/two-session-live-20261026.json`。
- 按 Astra 的自动化边界先补三个宿主约束：无法确定项目 cwd 时拒绝 `PROJECT_UNKNOWN`，不再使用共享 `workspace-unknown`；召回依赖从“本会话曾召回”改为按用户请求记录（checkpoint 只带当前请求实际召回的 active ID）；`/memory plan` 返回 `plan_id`/`data_version`，`forget` 必须带该 `plan_id`，核心在执行时重新核算，不一致返回 `DELETION_PLAN_CHANGED`。新增 2 个核心测试、2 个宿主测试。
- **尚未实现**：自动任务结束触发器、每轮自动检索注入、过期/候选保留预览和自动清理。Astra 的 3（自动 promote）保持关闭。`autoCheckpoint` 接口和核心幂等写入已离线落地。
- **未做**：第二 Harness 会话 UI 结果行展示原因、真实 `/memory confirm/revise/revoke/forget` UI 流程、新用户消息下的 live checkpoint；自动任务结束触发器、自动检索注入、删除 UI、自然语言写入和图片记忆也未做。
- **2026-10-27 运行记录/幂等收尾**：新增 `src/desktop_adapter/runs.py`，记录 `run_id/task_id/request_id/lifecycle/termination_reason/input_delivery/verification/checkpoint_write`，文件锁 + 临时文件原子替换，operation_id 幂等；`preact_replay.py` 已接入并输出 `run_id/run_record`。核心新增 `memory_operations` 与 `save_checkpoint(operation_id=...)`；宿主新增仅 host 可用的 `autoCheckpoint({consent:true, operation_id})` 接口，未注册模型工具、未接触发器。5 个 run ledger 测试、2 个核心幂等测试、1 个宿主接口测试通过。
- **桌面租约/Node 点击接入**：新增 `src/desktop_adapter/lease.py`，固定执行器在输入前获取 `runtime/locks/desktop-input.lock`，第二个请求返回 `DESKTOP_BUSY`；`runs.js` 让 `desktop_click` 在动作前后写 run，输出 `run_id/run_record`，`verification=unknown`，ledger 启动失败则不发送点击。新增 2 个租约测试和 1 个点击 ledger 测试；跨进程租约实测 `DESKTOP_BUSY`、0 输入（`results/run-ledger/lease-busy-20261027.json`）；Node ledger 桥合成检查（`results/run-ledger/node-client-check.json`）。尚未做真实桌面 live 重放。
- **W3 有限定位与 B03 对齐**：定位器升级为 `bounded_patch_search_v2`，不再要求 basis/fresh 整图同尺寸；参考补丁从 basis 提取，fresh 搜索受 `search_radius`/`stride`/`search_center` 和 20k 候选上限约束；支持最多 8 个有限尺度（0.5–3.0），返回 found/ambiguous/not_found/unsupported。PreAct 新程序可写 `visual_basis.region_space=client|window`、`scale_candidates`、`search_center`，旧 v2 仍传 `(1.0,)`。B03 新增 `template_region`/`after_region` 和各自的 critical region，允许整图尺寸不同但裁剪尺寸相同；旧 `region`/`critical_region` 兼容。**Live v3**：可见外框 `[110,22,1255,903]`、target `[17,58]`，定位器 found similarity 1.0/margin 0.334；整图 B03 因菜单只占 1.5% 误判，绑定菜单区域 `[0,35,400,350]` 后前置 failed 0.875736、after passed 0.999779；v3 proof 已保存，程序 run `expected_matched=true`。重启后新窗口偏移 1px，`desktop_observe region_space=window` 返回可见外框，`desktop_replay` v3 通过：locator similarity 0.998828/margin 0.332812、B03 after 0.999779、`program_condition_verified=true`、`task_success_verified=false`。窗口缩小到可见外框 `820×618`（DPI 仍 144）后，PreAct 以 `clipped_to_current_window=true` 截取当前外框；v3 replay 仍完成，locator 0.996094/margin 0.332812、B03 after 0.999564。`window` 区改为 DWM 可见外框；stdin 改 UTF-8。全量 Python **179**、Node **43**。未做 100/125/150% 三档 DPI 缩放验收；v3 仍是单尺度 `[1.0]`。证据 `results/localization/w3-v3-proof-20261028.json`、`results/desktop-replay/v3-live-window-bridge-20261028.json`、`results/desktop-replay/v3-small-window-20261028.json`。
- **帧稳定性/有界 settle**：Notepad 静止时 16 帧/约 1.8s 的整帧和目标框变化均为 0；执行器输入前最多 5 次、间隔 30ms 重新抓帧，匹配才继续，仍失败返回 `FRAME_CHANGED`；不重试动作。新增测试：短暂变化后稳定可点击、持续变化 0 点击。Python **179**、Node **43**。证据 `results/localization/frame-stability-20261029.json`。
- **W4 多步实验**：新增 `notepad-file-menu-toggle/v1` 两步程序（打开 File → 关闭 File），两步 basis 分别为菜单关闭/打开，B03 分别用打开/关闭模板。`verify_program` 完成两步（2 observation IDs、2 receipts、proof）；独立 `preact_replay.py` 重跑 `completed`，2 steps found、2 receipts、run record `passed`，B03 0.999564/0.986443，窗口缩小后两步 `clipped_to_current_window=true`。早先一次因 QQ 抢前台被 `INPUT_CHANGED` 安全拒绝（0 click/0 input），用户关闭 QQ 后重跑通过。host bridge 已开放最多 8 步并在重启后通过 v4 host 实测：2 steps found、2 receipts、`program_condition_verified=true`、`task_success_verified=false`，B03 0.999779/0.986364；没有 step2 失败回滚。失败实验：step1 打开菜单后，step2 越界目标返回 `TARGET_NOT_FOUND`，菜单保持打开、无自动回滚；cleanup 才关闭。修复失败路径丢失 prior receipts，结果保留 1 个 step1 receipt，测试 +1。证据 `results/localization/w4-multistep-20261028.json`、`results/desktop-replay/host-multistep-20261029.json`、`results/localization/w4-step2-failure-20261029.json`。
- **W5 前台切换安全**：Notepad action-ready 观察后切到 Harness 前台，再点击被 `FOREGROUND_CHANGED` 拒绝，0 click/0 input；随后恢复 Notepad，0 input。授权撤销。证据 `results/localization/w5-foreground-change-20261029.json`。
- **W5 重复窗口歧义**：同时有两个 Notepad 窗口（`test.txt`、`2606.07624v1.txt`），只用 `class_name=Notepad` 的 draft 返回 `WINDOW_AMBIGUOUS`，`window=null`、`activation=null`、0 receipts、0 input；没有猜窗口。证据 `results/localization/w5-duplicate-window-20261029.json`。
- **W5 两窗口精确 title 选择**：两个 Notepad（`test.txt`、`2606.07624v1.txt`）不重叠；v3 精确 title 只选 `test.txt` 并完成，run `98ff932e...`，无 action/observation 引用另一窗口。replay 后目标失去前台，cleanup 首次被拒；单独授权临时置前关闭菜单，随后恢复另一窗口前台。没有另一窗口 before/after 像素证明，不声称像素不变。证据 `results/localization/w5-two-window-exact-selection-20261029.json`。
- **加载状态**：磁盘插件 0.6.4，运行中的 0.6.4 已加载 W2 的 `region_space`/默认 client，并通过 live 验收；W1/W2 的 Python 路径每次调用即时生效。旧 v2 程序仍走 legacy outer+margin。W3 代码已落地，v3 proof 已生成；W4 多步 proof 也在。100/125/150% DPI 现场验收按用户要求暂不做。注意：`window` 区新语义（DWM 可见外框）已通过重启后的 live 验证。
- **视觉效率 P0/P1**：`capture` 增加 capture/encode/persist 拆分计时；action-ready 增加 identity/manifest/binding 计时；附件增加 read/hash/save/receipt 计时；PreAct 增加 locate/verify 计时。新增 `observation_policy.py`（几何/窗口身份/精确 RGB/32×32 块/critical/omitted/ShadowTracker）和 `benchmark_capture.py`、`compare_observations.py`、默认 off 的配置。9 个策略测试 + 1 个假 MSS 计时测试通过；已有一次 live smoke，但未做多任务/多状态成对基线、有界等待、自动路由或区域图。Node 附件/点击计时和 `action.js` 输出要重启才加载。
- **视觉 live smoke**：记事本 `hwnd=985238`、区域 `(200,250,400,300)`，仅 observe 授权后撤销。直接 capture 5 次中位 7.59/1.22/0.95 ms；action-ready 完整 Python 观察 68.48/69.35 ms，内部 capture 10–12 ms；两帧 unchanged；未附图片、未调模型、未输入。带图样本：PNG 4,622 bytes，capture 8.05 ms，工具调用 297 ms，工具结果到下一 assistant message 6,008 ms；模型处理段远大于本地截图。端到端仍需更多样本。证据 `results/vision-efficiency/notepad-live-p0-20261027.json`、`notepad-image-latency-20261027.json`。
- **P2 desktop_replay**：新增 `replay.js` 和 `desktop_replay` 工具，只接受已验证程序 ID/版本，不接受坐标/代码/动作数组；宿主一次调用内部执行 preflight/observe/locate/execute/verify，失败/unknown 停止；当前只允许单步，Python proof/授权/租约原样保留；返回紧凑结果、run_record 和证据路径。3 个 Node 测试；schema 已扩到 6 工具。真实无授权冒烟通过：`AUTHORIZATION_REQUIRED`、0 输入、0 截图。真实单步验收在授权后跑到 locate found [32,47]，但执行器因 `FRAME_CHANGED` 在输入前拒绝：0 click、0 input、0 receipt，未打开菜单。replay 的 session-id 传递 bug 已修复（0.6.3）；FRAME_CHANGED 需要后续稳定性/区域/重观察策略，当前不算成功。证据 `results/desktop-replay/no-grant-smoke-20261027.json`、`frame-changed-20261028.json`。
- **W0/W1 窗口上下文**：`FRAME_CHANGED` 回执增加局部诊断（changed_pixels/ratio/target_changed/bbox）；新增 `window_context.py`，在自建 per-monitor DPI 上下文读取外框、DWM 可见外框、客户区屏幕矩形、显示器交集、DPI/awareness、进程创建时间/session、geometry_revision。`desktop_windows`、action-ready observation、click-binding、executor 校验和 PreAct 步骤都带上/校验上下文；观察前后几何变化会丢弃观察。W1 只读：`action_context_available=false`，不改点击区域、授权或输入契约。Live 只读验证 Harness `hwnd=67848`：外框 1941×1243、客户区 1919×1232、DPI 144、per-monitor；UWP 进程/session 读取失败显式记录。证据 `results/window-context/live-context-20261028.json`；测试 +5。
- **W2 客户区/窗口区接入**：`desktop_observe` 新增 `region_space=client|window|explicit`；hwnd 无 region 默认 client，region 存在默认 explicit；client/window 从当前客户区/外框原点开始，不加固定 margin；action-ready observation/binding 记录并校验；执行器输入前重新读窗口上下文，身份/geometry revision 变化返回 `WINDOW_CONTEXT_CHANGED`。PreAct 对新程序支持 `visual_basis.region_space=client|window`，旧 v2 无字段继续 legacy outer+margin，避免破坏旧 proof。修掉 `window` 未赋值和回执 JSON 截断问题；`EXECUTOR_BAD_OUTPUT` 现在带 stderr/exit。Live 验收：默认 client 观察 1253×827，空白点击 1 click/3 events、`input_delivered=true`、屏幕点 [911,497]、post delta 0；移动后客户区原点 [178,140]，缩放后 948×603，恢复 1253×827。证据 `results/window-context/w2-live-acceptance-20261028.json`。前两次失败回执不完整，不能认证零输入；未对同一观察重试。
- **`/memory help` UI 已确认**：输入 `/memory` 只出候选；点选后蓝色命令 chip，`help` 为白色参数，必须发送；结果显示为会话里的 detached `>- memory · Usage...` 行，不是弹窗，长文本会被行宽截断；重复发送会出现重复行。`help` 不写记忆/来源。

## 2026-10-25 · 重启后 P0 现场验证（通过）

- Harness 重启后 `desktop_windows` 返回 `authorization_grants`，确认插件 0.5.1 新代码加载；旧授权 `ebfc1f5b-...` 仍在有效期。
- 现场工具链通过：`desktop_activate`（`foreground_confirmed`，0 输入）→ `desktop_observe`（[60,88,400,300]）→ `desktop_click`。目标 [22,47]→桌面 [82,135]，1 次点击/3 事件，`phase=after_input`、`stage=done`，执行器回执含 `authorization.grant_id`；动作后 B03 **passed 0.994526**，菜单已关闭。回执 `results/vision/b6d466c1-.../action-9ed5a9c0-....json`，B03 `results/b02/single-click-20261025/b03-live-grant-p0-phase.json`。
- 无授权窗口被拒绝：`desktop_activate(hwnd=327982)` 返回 `No active task grant covers activate`，未聚焦。
- B03 原点敏感性：第一次观察用 `[55,83,400,300]`，与模板原点 `[60,88]` 错位 5px，B03 `failed 0.755718`（假阴性，不是点击失败）；对齐后 `passed 0.994526`。模板必须和观察区域原点绑定。
- PreAct v2 初始在 hover 状态 `TARGET_NOT_FOUND`（raw 相似度 0.474）；新增 `edge_iou` 回退后完成：目标补丁背景从白变蓝仍能定位到 [32,47]（edge 0.9376，second 0.3266，margin 0.6110），授权点击完成，B03 **passed 0.994526**，`phase=after_input`。证据 `replay-p0-edge.json`、`b03-p0-edge.json`、`p0-edge-menu-closed.png`。
- 执行器成功回执的 `phase` 已修为 `after_input`；`tests/test_executor.py` 覆盖。
- 附件索引已有 6 条记录；保留 dry-run 为 6 个普通 vision 待删、49 个保留、6 个附件、0 错误，未执行 `--apply`。摘要 `results/b02/single-click-20261025/p0-restart-live-summary.json`。
- 测试：Python **179**、Node **43** 通过；六工具 schema/注册检查通过。下一步：B03 语义边界、授权加固、真实多步样本、记忆（等 Astra）。
- B03 通用加固：`compare_template` 增加可选 `critical_region`/`critical_tolerance`/`max_critical_changed`，用于关键文字区域；小范围关键改动即使总相似度 ≥0.98 也会 failed，critical 区域外改动不误报。CLI 已加对应参数；现场菜单证据 `b03-critical-region.json`（critical 0.0，passed 0.994526）。

## 2026-10-25 · 任务授权与证据保留策略

- 新增 `src/desktop_adapter/authorization.py` 和用户 CLI `scripts/authorize_task.py`：授权绑定窗口身份（hwnd/pid/class/title）、动作集合、Harness session、Windows session 和有效期；支持 list/revoke。授权文件在 `runtime/authorizations/`，是本地事故边界，不是签名。
- 授权已贯穿入口：`desktop_activate`/带 hwnd 的 `desktop_observe`/`desktop_click` 自动选择 session 授权；PreAct 适配器在激活前选择 `replay` 授权并检查程序 ID；固定执行器读取请求里的 grant_id，再核对窗口、动作、过期和 Windows session 后才输入。没有授权时返回 `AUTHORIZATION_REQUIRED`，越界窗口/动作拒绝。
- 真实样本：为 Notepad `hwnd=788882` 创建 1 小时授权（`ebfc1f5b-...`，四个动作），proof-bound v2 重放在授权下完成，执行器回执含 `authorization.grant_id`，B03 `passed` 0.994782，菜单已关闭。证据 `results/b02/single-click-20261025/replay-grant-v2.json`、`b03-grant-v2.json`、`grant-menu-closed.png`。
- 新增 `configs/retention.json`、`src/desktop_adapter/retention.py`、`scripts/cleanup_evidence.py`：普通 vision 24h、RGB 1h、程序视觉依据/模板长期保留、Harness 附件 24h；attachment 交付时追加 `runtime/attachments.jsonl`，清理只删索引内副本。默认 dry-run；首次 dry-run 为 6 个普通目录待删、30 个保留、0 错误，未执行 `--apply`。文档 `docs/retention.md`。
- 新增 `src/desktop_adapter/locate.py` 的限定区域重定位：在存储目标周围 `search_radius=64` 内以 stride 4 搜索目标补丁，要求 best 与分离的 second 匹配差距 ≥0.005；返回新的 `new_center`，`not_found`/`ambiguous` 停止，不降低阈值硬凑。适配器不再固定返回旧 [x,y]。
- 真实样本：v2 在授权下重放，目标补丁搜索从旧 [22,47] 定位到 [32,47]（相似度 0.9867，second 0.6269，margin 0.3598），仍点到“文件(F)”，B03 `passed` 0.994179；菜单已关闭。证据 `results/b02/single-click-20261025/replay-relocate-v2.json`、`b03-relocate-v2.json`、`relocate-menu-closed.png`。
- 多步程序已支持：适配器在任何动作前 preflight 所有步骤的窗口/授权/依据/区域；每步重新 activate/observe/locate/execute/verify；第二步 preflight 失败时 0 次动作，中途失败不回滚已完成步骤。单元测试覆盖两步成功与第二步失败；没有真实多步样本。
- 单步 v2 在多步重构后又真实重放一次：授权通过、重定位 found、`completed`、B03 0.994179；证据 `replay-v2-final.json`、`b03-v2-final.json`、`v2-final-menu-closed.png`。
- 测试：Python **179**、Node **43** 通过；六工具 schema/原生注册检查通过。仍未做：B03 关键文字/相似弹窗语义、全屏/大范围重定位、多步回滚/分支、强制终止后的按键释放保证、记忆 schema（等 Astra）。
- 授权 CLI 的默认确认是终端 `y/N`，`--yes` 可跳过；它防模型误操作越界，不防同一用户本地代码重写授权文件。Harness 工具重启后加载新插件代码；W4 host 多步已在当前重启后的会话通过。

## 2026-10-25 · Astra 评审修复：proof、三态验证、取消与回执真实性

- **verified 来源**：新增 `src/desktop_adapter/proof.py`，verified 程序必须带内容绑定 HMAC proof，绑定程序内容、视觉依据哈希、模板哈希、执行器/验证器版本和运行回执。外部 `parse_program` 只能创建草稿；`save_program`/`load_program` 校验 proof；模板或程序内容改动即失效。密钥在 `runtime/keys/program-proof.key`，防外部 JSON/工具输入伪造，不防同用户任意本地代码读取。
- **三态验证**：`inventory.replay` 只接受 `status == "passed"`；failed/unknown/布尔/格式错误均停止。PreAct 适配器新增 before-image 检查，动作前已满足目标返回 `unknown`，不判成功。
- **取消**：Node 启动器接收 AbortSignal，写取消文件给执行器；Python 执行器在输入前、按键前检查。取消后等待子进程退出；无法确认是否执行时返回 `cancelled_unknown`，不自动重试。取消/超时不再立即丢弃子进程。
- **回执真实性**：动作后异常不再把点击/事件计数清零；保留输入事实并返回 `unknown_after_input`、phase/stage。新增对应测试。
- **模板/程序绑定**：适配器核验视觉依据图哈希；模板路径限制在 `runtime/templates`；proof 绑定模板哈希/比较区域/阈值。早期适配器拒绝多步；W4 已用 `notepad-file-menu-toggle/v1` 验证 adapter/`preact_replay.py` 和 host `desktop_replay` 两步执行（2 steps/2 receipts），host 最多 8 步。
- 首个程序 v1 为旧的无 proof 记录，现已被 `load_program` 拒绝；已用真实 v1 运行回执生成 **v2** proof-bound 程序，并完成一次 proof-bound v2 重放：`completed`、`expected_matched=true`、B03 `passed` 0.994782，菜单已 Esc 关闭。证据 `runtime/programs/notepad-open-file-menu/v2.json`、`results/b02/single-click-20261025/replay-notepad-open-file-menu-v2.json`、`b03-preact-v2.json`、`preact-v2-security-summary.json`。
- 测试：Python **95**、Node **27** 通过。该轮未做任务级授权和保留策略（后续已补，见上）；B03 关键文字/相似弹窗语义、全图重定位/多候选、强制终止后的按键释放保证仍未做。

## 2026-10-25 · PreAct 适配层与真实重放通过（DPI 修复）

- 新增 `scripts/preact_adapter.py::ProgramReplayAdapter` 与 `scripts/preact_replay.py`。PreAct 只需加载程序并调用适配层：activate → observe → locate → execute → verify；不另写鼠标驱动，不绕过检查。`replay_program.py` 已改为薄封装。
- 首次 PreAct 运行在 `OBSERVATION_FAILED` 停止，未点击：适配层缺少 `physical_pixels` DPI 上下文，窗口 rect/区域在逻辑像素与物理像素间不一致。已把 prepare/observe/replay 包进 `desktop.physical_pixels()`；失败路径保留为诊断记录。
- 修复后真实重放 `completed`：激活 `already_foreground`、新观察 ID `1e431fce-...`、目标 [22,47]→桌面 [82,135]、1 次点击/3 个事件、`post_action_delta=0.664683`；`expected_matched=true`；B03 `passed`，相似度 `0.994782`。菜单已 Esc 关闭。
- 证据：`results/b02/single-click-20261025/replay-notepad-open-file-menu-v1.json`、`preact-summary-20261025.json`、`b03-preact.json`、`preact-menu-closed.png`；接口说明 `docs/preact_interface.md`。
- 测试：Python **83** 项（新增 5 项适配层测试），Node **25** 项，六工具 schema/注册检查通过。限制：适配层当前面向单步程序；目标定位是目标补丁匹配；B03 是区域模板。下一步可进入记忆功能，或把 PreAct 适配层接到界面/调度器。

## 2026-10-25 · B03 接入 replay，已入库程序重放通过

- `scripts/replay_program.py` 读取 `runtime/programs/notepad-open-file-menu/v1.json`：找到视觉依据图、激活记事本（`already_foreground`，0 输入）、重新采集 action-ready 观察；用目标补丁 `[0,27,64,40]` 对视觉依据做匹配，匹配通过（相似度 `0.990234`）后才采用当前观察下的 [22,47]。
- 重放经同一 `ActionClient` + 固定执行器执行：`ok=true`、`input_delivered`、3 个输入事件、桌面 [82,135]；`inventory.replay` 的 `expected_matched=true`、`fresh_observation=true`、状态 `completed`。动作后图交 B03 模板复核：**passed，0.994782**。菜单已 Esc 关闭并保存关闭后截图。
- 证据：`results/b02/single-click-20261025/replay-notepad-v1.json`、`b03-replay.json`、`replay-summary-20261025.json`、`replay-menu-closed.png`；动作后图 `results/vision/15269dec-.../screen.png`。本次是脚本触发重放，不是运行中 Harness 模型触发。
- 测试保持 Python 78、Node 25、六工具 schema/注册检查通过；`replay_program.py` 的控制台 Unicode 输出问题已改为 ASCII 转义，失败发生在结果写入之后，未重复点击。
- 下一步：PreAct 只保留接口，接实际重放前先把 replay 的 observe/locate/verify 回调整理成稳定适配层；或进入记忆功能。

## 2026-10-25 · desktop_activate 现场加载，activate→observe→click 通过

- 重启后真实会话确认 `desktop_activate` 已加载。链路：`desktop_windows` 取记事本 hwnd 788882 → `desktop_activate` 返回 `already_foreground`（`input_events_sent=0`、`clicks=0`）→ `desktop_observe`（400×300，`include_image=true`，图片通道已长期开启）→ `desktop_click` 附件目标 [22,47] 映射桌面 [82,135]。
- 点击结果：1 次点击、3 个输入事件、输入回读确认；动作后截图确认文件菜单展开，`post_action_delta=0.664683`，图片已附回模型。B03 用已存模板复核该现场动作后图：**passed，相似度 0.994782**。`task_success_verified` 仍为 false，仍是单样本视觉核对。
- 菜单已用 Esc 关闭并保存关闭后截图。证据 `results/vision/49236b35-.../observation.json`、`results/vision/beb2aaf2-.../screen.png`、`results/b02/single-click-20261025/live-activate-20261025.json`、`b03-live-activate.json`、`live-activate-menu-closed.png`。
- 当前五项工具均已在运行中 Harness 加载；图片通道为 true；首个程序 `runtime/programs/notepad-open-file-menu/v1.json` 已入库。测试保持 Python 78、Node 25、六工具 schema/注册检查通过。
- 下一步：把 B03 接入 `inventory.replay` 的 verify 回调，先做一次程序重放；PreAct 仍只保留接口，未接实际重放。

## 2026-10-25 · 置前动作常驻、图片长期开放、B03 与首个程序入库

- 新增 `scripts/window_activate.py` 和插件工具 `desktop_activate`：由 Medium 的 base Python 执行，检查自身/目标完整性、同 session、`WinSta0\Default`，拒绝 elevated 目标；只做前台切换，不发送鼠标键盘按键，并回读确认前台。脚本已实测 `foreground_confirmed`；六工具 schema/原生注册检查通过。（重启后该工具已加载，见顶部现场记录。）
- 按用户要求，`configs/desktop-observe.json` 的 `image_attachment_enabled` 改为 **true 长期开放**，不再逐次授权；图片通道测试同步改为断言 true。
- B03 最小视觉验证器落地：`src/desktop_adapter/verify.py` 用纯标准库解码 8-bit PNG，按区域与已验证模板比较，返回 passed/failed/unknown、相似度、变化比例和哈希；`scripts/verify_observation.py` 提供 CLI。真实结果：脚本链动作后图作为模板，对现场动作后图 `passed`，相似度 `0.994782`；对动作前闭合菜单图 `failed`，相似度 `0.823038`。证据 `results/b02/single-click-20261025/b03-verification.json`、`b03-negative-before-menu.json`。
- 首个程序已按重跑验证门槛入库：`runtime/programs/notepad-open-file-menu/v1.json`。视觉依据来自 `e5c4ae79-...`，验证 run 来自现场 `e74e4fc7-...`，动作只存“点击 文件(F)”的意图、不存坐标；预期结果引用 `runtime/templates/notepad-file-menu-open.png` 和区域 [0,35,300,260]。`save_program` 的 fresh-observation/版本/验证门槛通过，`load_program` 复核成功。
- 测试：Python **78** 项通过（新增 4 项视觉验证器），插件 Node **25** 项通过，六工具 schema/注册检查通过。下一步：重启加载 `desktop_activate`，现场走 `desktop_activate → desktop_observe → desktop_click`；把 B03 接到 `inventory.replay` 的 verify 回调；PreAct 仍只保留接口。

## 2026-10-25 · 现场模型驱动链路通过（四个工具）

- 用户重启后，真实 Harness 会话确认 `desktop_windows`、`desktop_observe`、`desktop_click` 均已加载。`desktop_windows` 返回 18 个可见窗口；选中记事本 hwnd 788882，先用 Medium 辅助进程将其置前。
- `desktop_observe` 传 `hwnd=788882`、`region=[60,88,400,300]`、`include_image=true`：生成 action-ready 观察（400×300，绑定、RGB 基线和附件齐全），观察 ID `b2edfa50-...`；图片中文件菜单位置约 [22,47]。
- `desktop_click` 传同一观察、标签“文件(F)”、附件中心 [22,47]：执行器映射桌面 [82,135]，1 次点击、3 个输入事件、输入回读确认；动作后截图确认文件菜单展开，`post_action_delta=0.664683`，并已通过工具把动作后截图返回给模型。`task_success_verified` 仍为 false，本次是单样本视觉核对，不是通用成功率。
- 验证后已用 Esc 关闭菜单，并保存关闭后截图；`image_attachment_enabled` 为本次验证临时设为 true，完成后已恢复 false。插件自身模型调用为 0；图片由当前 Harness 会话模型接收。证据：`results/vision/e74e4fc7-.../observation.json`、`results/vision/69033c7f-.../screen.png`、`results/b02/single-click-20261025/live-chain-20261025.json`、`live-menu-closed.png`。
- 未做：B03 自动预期结果验证器（菜单展开仍由视觉核对）；图片通道默认仍关闭；PreAct 只保留接口，尚未接入实际重放。Python 74 项、插件 Node 22 项测试保持通过。（后续用户要求置前常驻、图片长期开放并补 B03，见本页顶部记录。）

## 2026-10-25 · Harness 动作工具与 action-ready 观察链路（插件 0.5.0）

- 插件新增 `desktop_windows`、`desktop_observe` 的 `hwnd` action-ready 模式、`desktop_click`；后者只把附件像素坐标交给固定执行器，不直接输入。链路为 `desktop_windows` → `desktop_observe(hwnd)` → `desktop_click` → 动作后观察/`post_action_delta`；启用图片时可附动作后截图。PreAct 只保留接口，后续通过 `ActionClient` / Node `click` / `inventory.replay` 回调接入，不另写鼠标驱动。
- 新增 `plugins/dsh-desktop-observe/action.js`、`scripts/check_action_ready.mjs` 与 `scripts/run_action_chain_once.mjs`。先用真实记事本窗口验证 action-ready 观察（400×300，绑定和 RGB 基线齐全），契约目标 [22,47] 映射桌面 [369,113]，`gui_actions=0`，临时观察已删除，记录 `results/b02/single-click-20261025/action-ready-check.json`。随后用同一链路执行一次真实点击：`ok=true`、`input_delivered`、3 个输入事件、光标回读 (369,113)、动作后截图确认“文件(F)”菜单展开、`post_action_delta.changed_pixel_ratio=0.664683`；随后 Esc 关闭。证据 `results/vision/e5c4ae79-.../observation.json`、动作后图 `results/vision/49d5ead4-.../screen.png`、回执 `results/b02/single-click-20261025/action-chain-live.json`。
- 验证：22 项插件 Node 测试通过（观测 5、图片 11、动作 6）；`scripts/check_dsh_observe.mjs` 在 Electron ASAR 下通过 4 个工具的原生 schema 与注册检查，报告 `results/a04/dsh-observe-contract.json`；Python 全量 74 项测试通过。执行器的 Medium 自检、过期观察端到端拒绝、动作后 delta 均已覆盖。动作观察现在要求目标窗口在前台；被遮挡时在截图前拒绝，不再生成看似可用但实际被覆盖的观察。
- 未做：运行中 Harness 尚未重启加载 0.5.0，四工具未在真实会话出现；`image_attachment_enabled` 仍为 false，现场视觉闭环需用户确认开启（会把截图交给当前模型并产生输入 token）。固定执行器的真实点击已通过脚本/插件代码链路，但还不是运行中 Harness 的模型驱动验收。（重启后已在本页下一节完成现场验收。）
- 下一步：重启 Harness 后确认四工具可见；经用户确认开启图片通道，跑一次完整 observe→click→after-image 现场链路；再补 B03 预期结果验证器，之后接 PreAct 重放。

## 2026-10-25 · 固定动作执行器、统一契约与程序库存协议（0.5.0）

- 按用户四条边界实现，详细契约见 `docs/desktop_action_protocol.md`。执行器唯一实现为 `src/desktop_adapter/executor.py`，入口 `scripts/desktop_executor.py`；Harness 通过 `scripts/run_desktop_executor.mjs` 从 `.venv/pyvenv.cfg` 的 `base-executable` 启动它，不使用带 Low 标签的 `.venv\Scripts\python.exe`，未改 `.venv`、RAG 或系统安全设置。
- 双端完整性检查已实测：项目 `.venv` 启动自检为 Low，返回 `EXECUTOR_INTEGRITY_NOT_MEDIUM`；base Python 启动自检为 Medium，依赖齐全；Node launcher `--self-check` 同样返回 Medium。目标高于 Medium、跨 session、非 `WinSta0\Default`、画面/窗口/输入变化均拒绝，且拒绝时不发鼠标按键。
- 统一坐标契约：请求携带观察 ID、`screen.png` 哈希、图片尺寸、桌面原点和图片像素目标；执行器自行映射，调用方不能提供屏幕坐标。当前只接受未缩放观察；一次观察写 `click.once`，指针移动回读失败不发送按键，动作后保存新截图，`task_success_verified` 始终为 false。
- 规划与重放共用 `ActionClient` / Node `click` 接口，PreAct 后续也只能走这一入口。Python 客户端在 Low 进程内会在启动执行器前返回 `CLIENT_INTEGRITY_NOT_MEDIUM`；Harness/Node 是 Medium 启动路径。
- 程序库存 `src/desktop_adapter/inventory.py`：保存视觉依据、前置条件、点击意图、预期结果和执行器版本；动作对象禁止保存坐标。`save_program` 只接受重跑验证成功的程序，要求每步使用新的 observation ID；重放遇到状态不匹配、目标丢失或执行器拒绝即停止/重新规划，不自动重试。
- 新增 31 项契约/执行器/客户端/库存测试；全量 74 项 Python 测试通过（`test_action_contract` 9、`test_executor` 7、`test_action_client` 3、`test_inventory` 12）。另用过期观察经 Node launcher → 执行器端到端返回 `OBSERVATION_EXPIRED`，`gui_clicks_attempted=0`，确认拒绝路径不输入。本轮没有新增真实桌面输入；动作证据仍是 `results/vision/93acb68b-.../click-result.json` 的菜单展开。
- 下一步：把 Node 客户端注册为 Harness 动作工具/插件；补 B03 结果验证器（菜单是否展开不能只靠模型口头确认）；再接 PreAct 重放。执行器尚未注册为 Harness 工具，在线宿主验收仍待做。

## 2026-10-25 · 单步点击复测通过；根因是解释器低完整性，不是误点

- 用户要求只启动一次点击程序。第一次从项目 `.venv` 启动时在指针移动校验处安全中止：`SendInput` 返回 1，但光标未移动、输入时间戳未更新，未发送鼠标按键，因此没有误点。该次中止不是用户操作造成。
- 对照诊断：`.venv\Scripts\python.exe` 与基础 Python 3.14.9 是同一 SHA-256 二进制，但该文件带 `Mandatory Label\Low Mandatory Level`（继承自当前工作区/沙箱），Windows 以低完整性启动它；基础 Python 无此标签，运行在 Medium。Low 进程的 `SetCursorPos`/`SendInput` 被 UIPI/桌面权限拦截，而记事本为 Medium。工作区 ACL 中还有沙箱授予项，故当前动作执行器不宜继续使用该 `.venv` 解释器。
- 用同一 Python 3.14.9 的 Medium 副本挂接项目 `.venv` 的 site-packages，直接调用项目现有 `observe`/`execute` 重跑：光标移动到 (389,114)，`SendInput` 接收 3 个事件，`input_delivery_observed=true`；动作后截图显示“文件(F)”菜单展开，用户现场确认收到，随后用 Esc 关闭。项目点击代码本身正常；首次失败不是误点。
- 证据：`results/vision/93acb68b-51a2-4468-8417-7a1ef9cb909f/click-result.json`、动作后图 `results/vision/c5277dba-866a-48e5-b25f-5687fc8ed903/screen.png`、`results/b02/single-click-20261025/evaluation-medium-20261025.json`、`recognition-live-cd0cf843-c98c-421c-959e-d29579488f27.json`；诊断脚本 `token_probe.py`、`input_api_diagnostic.py`、`input_environment_diagnostic.py`、`run_once_medium.py`。
- 本次识别为本会话模型对同一 800×600 截图的复核（图像哈希与上次一致），没有新增付费请求；只验证一个菜单目标，不构成通用准确率。回执中的 `task_success_verified` 仍为 false，菜单展开由动作后截图与用户独立核对。
- 影响与下一步：工作区内带 Low 标签的 Python 动作执行器无法向正常应用注入输入。后续动作执行应放在 Medium 进程（宿主 Node 层，或工作区外的 Python 环境），或经用户确认后修正 `.venv` 的完整性标签。记忆与 preact 接入不受此输入限制影响。

## 2026-10-25 · 首次单步点击闭环完成核验，结果失败

- 按用户要求，定位、单次点击尝试、截图核验结束后才统一更新进度。项目使用 MSS 和本地 Win32 SendInput CLI 原型，没有依赖 Codex 窗口截图接口；未新增依赖，不修改 RAG。动作尚未注册成 Harness 工具。
- 新截图 800×600，经原生 Flash 两轮请求得到文件菜单位置 (34,51)，映射物理桌面 (484,145)，本地视觉复核处于菜单内。未使用的帮助菜单坐标 (252,51) 实际落在查看菜单，说明结构合法不能证明语义定位正确。
- 输入前检查 180 秒新鲜度、截图哈希、窗口身份/几何、前台与最近输入状态、目标遮挡、目标附近像素严格一致；其余画面只允许极少量像素变化以兼容光标闪烁。一次性锁防止同一观察重复点击。SendInput 返回接收 3 个事件，但动作后及延迟截图均与之前一致。用户提供截图并说明“我没有动”，确认文件菜单未展开，本任务结果 failed。
- 原始回执的 transport_completed 仅代表 API 应答，不能解释为实际送达。已补上即时鼠标/前台/输入时间回读；回读无法确认则返回 INPUT_DELIVERY_UNCONFIRMED，不自动重试。5 项点击防护测试与 6 项坐标测试通过；未增加真实点击或付费请求。
- 只读诊断确认 x64 INPUT=40 字节、MOUSEINPUT=32 字节、union 偏移=8；执行进程和前台窗口同为 session 1，WinSta0/Default，输入桌面也是 Default。尚不能确定输入未生效的根因，不认定为 DPI、UIPI 或 Codex 限制造成。
- 证据统一保存到 results/b02/single-click-20261025/：用户截图、evaluation.json、read-only-diagnostics.json。原始观察/模型/动作回执路径在评价中。RGB 临时基线和模型临时目录已清理，正式证据保留。
- 下一步定位输入投递问题并对照本地宿主执行环境；取得实际菜单展开证据前，A04/B02 不标完成，不能继续多动作流程。

## 2026-10-25 · 记事本跨应用只读样本通过

- 用户准备两行测试文字后，采集记事本标题、菜单和正文区域 1906×976，排除底部无关悬浮提示；未操作或保存文档。沿用与计算器相同的观察工具、原生 AgentLoop 和通用视觉问题，无应用专用识别分支。
- 真实 Flash 两轮请求完成工具选择、图片接收和 JSON 回答；严格结构校验通过。两行正文“桌面助手识别测试”“今天只验证识别，不执行操作。”完全匹配；标题及未保存星号识别正确。文件、编辑、帮助的附件中心 (34,57)、(105,57)、(330,57) 均位于对应近似视觉框内。
- 评价 passed_this_sample，仅代表该样本。模型提到可能缩放的不确定性，而原生附件证据确认仍为 1906×976。未评价裁剪外的底部状态栏；坐标属于保存截图，actionable=false。仍为 CLI 调用插件同一 worker launcher，未冒充宿主在线命令现场验收。
- 结果目录 results/b01/readonly-ba41dd30-c2a1-4a8f-98b4-e28d88146db4/，原图 results/vision/95c721bf-8a57-4837-91e7-fa58a46051c2/screen.png。本轮已关闭，未计算费用，临时全桌面预览及 worker 临时目录已清理，正式证据保留。
- 去掉早期图片 token 固定阈值，按现有 200 万像素原生附件上限检查；输出 token、请求次数和传输大小约束不变。结构失败会作为失败返回，保留 loop_completed 区分链路完成与结构通过。
- 下一步进入单步动作闭环：刷新截图→定位→确认画面仍匹配→单次低风险输入→新截图验证结果。A04/B01 尚不因两个应用样本而整体标完成，输入执行和现场在线命令仍待验证。

## 2026-10-25 · 小窗口真实视觉验证，后续小试取消费用预留

- 用户已明确后续小规模验证不用计算消耗，继续推进。新增 small_readonly_validation 模式：不推导金额、不校验价格时效、不重复申请预算；仍限制每图最多 3 次请求、每次输出 1024 token、超时、图像哈希、会话绑定和一次性运行。旧金额模式仅为历史兼容保留，不复用旧试验。
- 730×796 计算器区域图来自用户缩小后的窗口，历史面板已收起，构成新的布局样本。真实原生工具→图像→Flash 回答共 2 次请求，无重试、无桌面输入。标准模式、显示 0 判断正确，=、0、C 三个中心均位于对应近似视觉框内；前轮错误的 not_run 表述没有复现。
- 回答末尾多出一个 ]，严格 JSON 解析失败，评价 partial。保留原回答，没有静默修复或将其作为动作输入。已新增通用结构校验（JSON、字段、坐标类型及边界），提示要求单个 JSON 对象；格式正确也仍标为 actionable=false，不能替代视觉和任务检查。
- 证据：results/b01/readonly-2cd471b9-10c2-4f33-b747-0ce59cc55c58/。新图 results/vision/98814e2a-c983-4ea3-84b8-9048470849d3/screen.png。CLI 通过插件同一 worker launcher 执行，不记为实际宿主在线命令验收。本轮已关闭；全桌面临时预览和 worker 临时目录已清理。
- 新次数模式在真实 SDK 本地 SSE 离线回归通过；本轮相关 18 项测试通过，另有 9 项图片交付测试此前通过。等待记事本测试页准备，继续不同应用验证。

## 2026-10-24 · 真实原生工具→图片→识别链路完成，2 次请求

- 用户批准本轮最多 ¥6.40、3 次请求、每次输出最多 1024 token，仅发送已确认计算器图。本轮通过插件同一隔离进程启动函数执行，入口为 Codex CLI，未操作 Harness 输入框；没有把它记为实际宿主在线命令点击验收。
- 真实 Flash 第一轮发出 `desktop_observe` 调用，参数 include_image=true；原生 AgentLoop / ToolRuntime 返回原生图片，第二轮实际发送的图片 SHA-256 与批准图一致，随后模型返回 JSON 并结束。共 2 次请求，1 次携图请求，无失败和重试。
- 本地复核：计算器、标准模式、显示 0、无遮挡判断成立；C、7、= 的中心 (477,459)、(97,687)、(666,1026) 均在对应按钮近似视觉框内。坐标仅属于原截图，未点击，actionable=false。
- 回答质量仍有两处问题：照抄“No recognition was run”，把工具采集阶段状态误作最终回答状态；右侧历史/记忆面板被笼统描述为空背景。已澄清工具提示中的阶段含义，但未追加付费请求验证措辞修复。评价为 partial，不记为通用准确率通过。
- 总 usage：输入含缓存 2745、输出 198，总计 2943 token。按全部输入高峰未缓存价保守估算 ¥0.007074；实际账户扣费未知。¥6.40 是批准上限，账本预留不是实际扣费。
- 配置已 completed，同一入口重跑会在启动前拒绝。剩余 1 次额度不复用，临时附件和图片副本已清理，无新截图或桌面动作。
- 证据：`results/b01/readonly-954f7af6-5114-4a89-9488-16935d48ee73/` 中的 result、evaluation、local-visual-review、launcher、closeout 与 ledger。图片与首轮相同，此次增加的是实际模型工具调用链路证据，未增加独立场景覆盖。
- 下一步验证不同窗口尺寸/记事本的视觉稳定性，再进入单步动作和动作后检查。A04/B01 保持部分完成。

## 2026-10-24 · 下一轮原生会话试验图片已准备，待批准

- 用户确认计算器置前。computer-use 窗口截图两次超时，刷新绑定后仍失败；改用项目 MSS 的只读可见像素入口，先本地预览再采集计算器区域，未操作窗口。
- 选定图：`results/vision/ed721669-52a1-4468-ac4f-ddc5f9134a39/screen.png`，1240×1088，桌面原点 (192,237)。本地查看确认仅计算器、标准模式、0、无遮挡。SHA-256 与首轮开发图一致，因此此次验证完整工具调用链路，不作为新增布局准确率样本。
- 修正在线入口沿用离线小图限制的问题：在线附件上限为 200 万像素，离线夹具仍为 8 万。原生附件服务预检查确认此图保持 1240×1088，发送字节哈希不变，图片估算 808 token；没有网络或模型调用。回答约束为至多 5 条文字、3 个目标，输出仍限 1024 token。
- 草案与图片预检查报告在 `results/proposals/readonly-954f7af6-5114-4a89-9488-16935d48ee73/`，绑定已验收的真实父会话。未修改运行配置、未批准预算；拟申请最多 3 次（含失败/重试）、总预算 ¥6.40，仅此单图只读识别。
- 已删除临时全桌面预览 PNG，保留采集元数据与清理说明；原生附件预检查临时目录已清理，选定图片和正式证据保留。

## 2026-10-24 · desktop-offline 现场验收通过

- 用户确认新命令有候选并显示“隔离会话离线自检通过 / OFFLINE_NATIVE_WIRE_IMAGE_RECEIVED”。磁盘回执核对为 15:04:43 UTC，父会话 `session-de84a1ba-d841-40e6-9535-22cfb9d6c1aa`，不是测试脚本的 fixture 会话。
- 本次命令→隔离进程→原生会话及 SDK→本地模拟响应→可见返回，现场链路通过。该次自检模型请求、新截图、桌面操作为 0，临时目录已清理；不代表真实模型选择工具或视觉准确性通过。
- 已将可覆盖的运行回执归档至 `results/host-session-check/20261024-150443-offline.json`，验收说明在同目录 `20261024-150443-acceptance.json`。A04 的现场离线链路完成，A04/B01 的在线部分继续推进。
- 下一步准备新的计算器可见区域图和具体试验草案，确认范围后申请新预算。在线配置仍为未批准、预算 0；当前等待用户将计算器置前并显示 0。

## 2026-10-24 · 修复参数命令落入普通聊天（0.4.1）

- 用户现场确认 `/desktop-trial` 有候选且显示本地状态；带 offline 参数无候选，提交后调用普通 DeepSeek 聊天。这次调用由用户报告，次数及金额未从账单确认，不计为受限试验，也不宣称整个现场尝试零费用。
- 根因已由安装版客户端源码和执行复现确认：未声明 input 的命令在 matchEnter 中遇到尾随文本直接返回 undefined。之前只验证 CommandRuntime 后端能解析参数，未覆盖客户端接管规则，验收覆盖不足。
- desktop-trial 补充 input.hint，旧参数写法在新版被命令输入区接管；新增独立无参数 `/desktop-offline`，从候选直接执行离线模式，不能通过参数选择付费运行。客户端结果提示覆盖新名称。
- 执行安装版客户端原方法体，复现旧分派失败并验证修复后的 claim、菜单点击和裸命令回车。原生命令→实际子进程链路再验证通过；14 项相关单元测试通过。证据 `results/a04/dsh-composer-dispatch.json` 与 `dsh-session-command-offline.json`。
- 本轮修复验证没有模型请求、新截图或桌面操作，临时目录已清理；在线配置继续未批准。源码版本 0.4.1，下次重启后用 `/desktop-offline` 现场验收，不再要求发送旧带参数写法。离线自检不需要批准 ¥6.316032 的在线预算提示。

## 2026-10-24 · 0.4.0 受限会话入口就绪，在线关闭

- 新增 `/desktop-trial` 状态查看、`offline` 零费用自检和受批准约束的 `run`。插件通过 IPC 启动独立进程，内部使用原生 AgentLoop、工具和 SDK，结果返回原命令；不修改共享宿主 fetch 或 RAG。
- 原生命令→实际子进程→本地 SSE→命令结果的集成通过；IPC 取消与临时清理通过。17 项相关单元测试通过。源码为 0.4.0，运行中客户端仍待下次重启验收。
- 重新核对官方价格与上下文，按完整上下文 1,048,576 输入 token + 1024 输出 token、高峰价预留：单次 ¥2.105344，最多 3 次 ¥6.316032。这是保守上界，不是预计消费。价格记录有效 24 小时。
- 新配置 draft、approved=false、预算 0，无绑定截图或会话；未批准 run 在加载 SDK/凭据前拒绝。不复用已关闭的 ¥0.50 试验。真实试验需具体截图、会话、30 分钟内有效期和新预算批准。
- 本入口只提供一张已确认的保存截图，不代表实时屏幕，不能据此点击；结果仍需独立评价。详情见 `docs/restricted_session_entry.md`。
- 本轮无 API 调用、新截图或桌面操作，临时目录已清理。下一步为下次重启后的零费用现场检查，再准备只读小试。A04/B01 仍进行中。
- 补充只读草案准备脚本：校验 15 分钟内的新截图、哈希、尺寸和会话，生成独立 plan/review 文件，不修改运行配置或自动批准。新增 2 项测试通过，相关单元测试累计 19 项。

## 2026-10-24 · 原生 SDK 发送边界与持久配额离线验证

- 新增独立传输限制器，校验实际 Messages 请求、只读工具历史和固定图片哈希；拒绝独立文件上传。请求前独占写入并同步账本，失败和重试不退额度，重新加载后继续计数。
- 原生 AgentLoop + DeepSeekAdapter + 附件服务的两轮本地 SSE 集成通过：第一轮调用观察工具，第二轮确实携带图片，模拟结果正常结束；重新加载后的第三次请求被拒绝。报告 `results/a04/dsh-native-wire-offline.json`。
- 修正前一版循环夹具缺少原生用户消息封装的问题；5 个旧循环案例重跑通过。新增 5 项发送限制测试和已有 3 项逻辑限制测试通过。
- 费用账本预留运算已实现，输入 token 对应的人民币硬上限仍未核定，明确标记 monetary_bound_verified=false。未开放在线入口，也未重新启用已关闭的 ¥0.50 试验。
- 真实 SDK 使用全局 fetch，当前只在隔离进程测试，未修改共享宿主。后续仍需隔离工作进程接入、费用上界核对与现场只读验证。详情见 `docs/desktop_wire_validation.md`；A04/B01 仍进行中。
- 本轮 0 付费调用、0 新截图、0 桌面动作；临时图片、附件库和测试账本已清理。无需现在重启 Harness。

## 2026-10-24 · 原生会话循环离线验证完成

- 复用已安装 Harness 的 AgentLoop、SessionStore、ToolRuntime、LlmRuntime 与附件服务，验证模拟模型发出工具调用→工具返回图片→下一轮收到同一附件→返回模拟结果→会话结束。截屏用既有开发图，模型用本地确定性响应，不计为新的真实识别成绩。
- 5 个集成案例通过：正常图片、关闭图片、哈希错误、请求超额、工具执行时取消。另有 3 项会话限制测试通过；工具出错也形成配对的调用/结果记录。
- 新增按 session_id 绑定的逻辑请求限制器，覆盖失败/标题调用计数、路由、输出和序列化体积；未在插件入口启用，不改变运行中宿主。它不是实际 token/费用硬限额，持久化预算及适配器内部 HTTP 仍待落实。
- 交付 `scripts/check_dsh_agent_loop.mjs`、`docs/agent_loop_validation.md`、`results/a04/dsh-agent-loop-offline.json`。临时图片和隔离附件库已清理，未发 API 请求、未采新截图、未操作桌面。
- 遵从用户要求暂不重启 Harness，0.3.1 的可见提示与下一轮现场验证集中安排；A04/B01 仍进行中。

## 2026-10-24 · 实际宿主自检通过，补充命令结果提示（0.3.1）

- 用户报告新会话执行命令仍无可见结果。项目回执证实同一实际宿主 PID 28212 在 12:13:24、12:14:57（北京时间）两次成功执行 `desktop_monitors`，返回一个 2560×1440 主显示器，native 调度，0 模型调用、0 截图、0 桌面动作。会话目录确为本项目，不能再归因为目录错误或用户未提交。
- 最新证据：`results/host-check/c7b06c54-648e-49cd-afee-dd606fc6f90d.json`。实际宿主命令→工具→Python 的连接验证通过；模型主动选择工具、宿主截图附件及动作循环仍未验证。
- 宿主客户端源码将成功的命令返回交给时间线显示，不在输入框重复提示；本次用户看不到结果，而压缩会话文件当时仅有 header。具体时间线未展示的内部原因未最终确认，不能用磁盘缺少 command 事件推断执行未发生。
- 新增插件客户端入口，订阅本命令的 `command/executed`，直接使用宿主输入框 notice 通道显示返回值。只处理当前命令及对应会话，失效会话不转发到其他会话，不追加用户/助手消息、不触发模型。
- 7 项命令及客户端测试通过。0.3.1 经现有本地 link 更新，下次重启加载；实际可见提示仍待现场验收。本轮未新增临时文件、依赖或付费调用，不改 RAG。

## 2026-10-24 · 0.3.0 宿主本地自检命令已准备

- 审阅本机 DSH 0.2.1-rc.2 的 commands、tools 与 llm 实现，确认本地命令无需启动模型回合；新增 `/desktop-check`，通过宿主工具调度只读取显示器列表。
- 命令检查工作目录、输入和取消，保留工具可见性/权限/调度规则；失败时不直接调用工具函数绕过宿主。结果写入 `results/host-check/`，不包含截图或识别成功声明。
- 18 项 Node 测试通过。原生命令解析、工具调度及 command/run、command/done 生命周期的集成检查通过；显示器函数和会话为夹具，不冒充运行中宿主结果。报告 `results/a04/dsh-host-command-contract.json`。
- 版本通过现有本地 link 更新，无安装和 profile 修改。需用户重启 Harness，在本项目会话里从命令候选选择 `/desktop-check` 执行，以完成实际宿主验证。候选未出现时不提交普通聊天。
- 此轮无截图、模型请求或桌面动作。未启用全局图片开关，未复用已关闭的首轮额度；完整在线会话的费用限制仍待实现。未发现新临时目录，RAG 和原环境保持不变。

## 2026-10-24 · 首轮真实 Flash 视觉识别完成，B01 部分通过

- 用户批准最多 3 次请求、总预算不超过 ¥0.50。本轮只发出 1 次请求，无重试、标题生成、鼠标或键盘动作；余量未使用，试验配置已关闭，重复发送会在读取凭据和网络请求前拒绝。
- 使用本机 Harness 原生 DeepSeek SDK 与附件服务的隔离入口，不是运行中 Harness 会话的工具调用。仅发送现场复核过的计算器区域图（1240×1088，原点 192,237）；全桌面预检查图未发送。
- Flash 正确识别「计算器 / 标准 / 0 / 无遮挡」。等于按钮中心 `(666,1020)` 落在按钮内，对应拍摄时屏幕 `(858,1257)`；预测框上边缘偏高，未满足完全落在按钮内的严格条件。近似人工视觉框的 IoU 为 0.8546，不能作为精确标注或通用可靠率。
- 实际 usage 为输入 1005、输出 52 token；按已核对空闲时段单价估算 ¥0.001213，按较高单价为 ¥0.002426。实际账户扣费未知，未将估算写为账单。
- 在请求边界限制官方端点、模型、单张已审查图像、文本体积、输出上限和持久化请求次数；真实请求输出上限为 1024 token。图片实际计数 808 token，未携带聊天历史或工具定义。
- 证据：`results/b01/flash-readonly-20261023/result-1.json`、`evaluation.json`、`events.jsonl`；评价分别记录状态、点位和框误差。A03 事件已关联原图哈希；整体验收仍为 partial/unknown、actionable=false。
- 下一步是运行中 Harness 会话的真实工具调度及不同窗口尺寸的只读验证，然后再进入低风险动作。全局图片开关仍关闭；A04/B01 不标全部完成。RAG、环境依赖及 CUDA 均未改动。
- 收尾验证：2 项请求边界/并发配额测试通过；实际执行已关闭入口，在加载 SDK 和凭据前拒绝，请求记录仍只有 1 条。已删除附件服务的空 tmp 目录，扫描未发现项目生成的临时目录或字节码缓存；正式证据、备份和用户下载保留。详见同目录 `closeout.json`。

下方记录为各阶段历史状态，以本条为当前状态。

## 2026-10-23 · 用户报告 0.2.0 重启，准备受限小试

- 用户已报告再次重启；本地源码为 0.2.0，图片开关仍关闭。实际宿主工具调用未执行，不将重启报告记为端到端识别通过。
- 官方当前文档确认 `deepseek-flash` 为 V4.1-Flash-1017、支持图片；本机 profile 默认官方 Flash。未读取或展示 API 密钥。
- 已准备 `docs/flash_readonly_trial_proposal.md`：一张计算器区域图，最多 3 次模型请求，申请上限 0.50 元。按官方较高时段价格及拟定 token 限制估算最高 0.218304 元；限制尚需在请求边界落实。
- 发现宿主 provider 默认输出上限为 256000 token，不能直接把提示词中的“简短回答”当费用保障。继续保持图片开关关闭，预算批准及限制验证后才执行远程小试。

## 2026-10-23 · Flash 原生图片通道离线完成（插件 0.2.0）

- 新增 `image-delivery.js`：沿用当前会话模型/凭据，检查 image 能力，保存 Harness 附件，返回文字与原生图片块。默认保留只读元数据入口；无自动首帧、输入或应用特化。
- `configs/desktop-observe.json` 的图片开关保持 false；预算尚未批准时，显式图片请求在截图/模型目录解析前拒绝。此开关不等于全局费用限额。
- 每张附件携带实际尺寸、原图哈希与坐标映射，保存 `model-image.json` 准备回执，不把附件准备记为图像识别成功。
- 14 项 Node 测试通过。DSH 0.2.1-rc.2 原生注册/卸载检查通过；真实附件服务将已有 1245×1093 图归一化为 301×264，读回、图片块及中心映射 `(812,781)` 均通过。结果见 `results/a04/dsh-image-delivery-offline.json`。
- 测试使用项目内隔离附件库，finally 校验路径后清理；未写全局附件库、未采新图、未发 provider 请求。RAG、CUDA 和环境依赖未变。
- 已有本地 link 指向新版源码，无需重装；运行中 Harness 尚未重启加载 0.2.0。下一步确认正式小试预算与调用限制，再进行只读识别；A04/B01 尚未全部完成。

## 2026-10-23 · Orb 视觉链路审阅与路线修正

- 用户指定使用 Harness 现有 Flash；本机内置模型目录明确声明 `deepseek-flash` 为 DeepSeek-V4.1-Flash、支持 text/image。没有通过模型别名推断具体 1017 服务端快照。
- Orb 的核心方式是保存 Harness 附件并返回图片内容块，由当前会话模型识别；无需另配视觉模型。当前截图插件只返回 JSON，下一步补附件通道并离线验证，Vision Toolkit 改为备选。
- 本地 ZIP 缺少部分核心文件，在线阅读作者 route.ts、observe.ts、plugin.ts 补充核对；没有安装、复制源码、发 API 请求或操作桌面。详见 `docs/orb_visual_reuse.md`。

## 2026-10-23 · Harness 只读工具接入（A04/B01 继续进行）

- 已完成无弹窗桌面截图复核，以及 Node→项目 Python→PNG/事件记录的桥接小试。计算器标准模式显示 0；此为开发看图检查，非 DeepSeek 自动识别。
- 新增原生插件 `plugins/dsh-desktop-observe`，仅注册 `desktop_monitors`、`desktop_observe`，绑定本项目会话目录，无启动时采集、输入动作、网络或模型调用。
- 离线 link 安装到 desktop profile，原 RAG 依赖与配置补丁不变，原始 profile 文件备份在 `runtime/backups/desktop-observe-20261023/`。
- DSH 0.2.1-rc.2 原生 ToolRuntime 的注册/卸载及 JSON Schema 检查通过；5 项 Node 测试通过。离线截图与契约报告在 `results/a04/dsh-observe-*.json`。
- 用户已重启 Harness，并确认「设置 → 内置插件 → 全局插件」出现 desktop-observe；记录为用户核对的宿主插件可见性。Computer Use 读取窗口授权超时，实际工具调用仍未验证，不将插件可见等同于端到端调用成功。
- 已审阅本地 Vision Toolkit 0.1.47 的 `vision_glance` / `vision_ground` 接口：前者读图描述，后者返回分析图像中的像素框；分析图可能经过缩放，必须按返回尺寸映射到屏幕。只读小试准备见 `docs/vision_trial_plan.md`。
- 下一步：选择视觉服务并核对预算控制，再执行只读识别小试。当前不发模型请求，`recognition_status=not_run`、`actionable=false`，不标记 A04/B01 完成。
- 临时文件检查未发现本项目遗留的 tmp/temp 目录、`.pyc` 或临时日志。正式截图、测试结果、安装备份及用户下载的压缩包保留。

## 2026-10-23 · 视觉路线调整与只读截图（A04/B01 部分完成）

- 用户决定：通用视觉优先；暂停计算器进程名/UIA 特化路线。下方旧条目保留为历史，旧“等待 PyCharm 列进程”不再是下一步。
- 新增 `scripts/vision_probe.py`、`src/desktop_adapter/vision.py`、`docs/visual_observation.md` 和 6 项坐标测试。
- 复用 Windows-MCP 支持的 MSS 后端；核对 PyPI 版本/Python 支持/wheel 哈希后，只向助手 `.venv` 安装 MSS 10.2.0，无运行时依赖，未改 RAG 环境。
- 首次真实截图成功：run `200539f5-a602-4abb-a45f-f32522bd10b5`，2560×1440、183.11ms。该图存在 python.exe 错误弹窗；用户随后关闭并完成干净截图复核，见上方新记录。
- 项目测试 35 项通过、pip check 通过。结果见 `results/a04/tests-vision-2026-10-23.txt`。没有点击、键盘输入或模型 API 调用。
- 当前 `recognition_status=not_run`，说明 DeepSeek 自动识别尚未接通；截图成功与开发者看图确认不能计为完整 B01。A04 未做低风险动作，不标完成。
- 新下载 Orb ZIP 含 151 个文件，与解压内容逐项一致；压缩包本身缺少 computer-use/package.json、src/plugin.ts 等构建文件，只作为局部参考，不直接安装。

## 2026-10-23 · A02 · 完成（场景定义）

- 交付：`evals/scenarios/v1.json`、`evals/scenarios/README.md`。
- 定义桌面、记忆、RAG 三类产品任务；首批桌面包括计算器/记事本只读识别、计算器 12×34、记事本另存测试文件。
- 明确初始状态、结果证据、失败类型、超时和允许动作；只读采集成功不自动计为识别正确。
- 本阶段只完成定义，未执行记忆、RAG 或桌面动作实验；当前案例属于开发集，不宣称留出可靠率。

## 2026-10-23 · A03 · 完成（统一事件与示例）

- 交付：`src/assistant_core/events.py`、`docs/event_contract.md`、`scripts/demo_events.py`、`tests/test_events.py`。
- 结果：14 项事件测试通过；持久化 run/session/用户作用域、观测/动作/记忆/回答/评价关联；区分工具状态与业务结果，拒绝无证据成功与跨 run 证据。
- 命令：`.venv\Scripts\python.exe -B -m unittest discover -s tests -v`；`.venv\Scripts\python.exe -B scripts\demo_events.py`。
- 结果文件：`results/a03/synthetic_success.jsonl`、`synthetic_interrupted.jsonl`、`events.sqlite3`。全部为模拟协议示例，未作为桌面/记忆效果结果。
- 限制：中断恢复需确认旧执行者已停止后显式调用；证据登记并不自动证明内容真实，仍需后续外部结果验证器。

## 2026-10-23 · A04 · 进行中（依赖与只读原型）

- 版本与依赖：官方 PyPI 核对 Windows-MCP 0.8.8（Python >=3.14）和 pywinauto 0.6.9。前者本次 dry-run 拟新增 91 个包，未安装；后者 4 个包均有可用 wheel，已按版本/SHA256锁安装到项目 .venv。
- 安装产物：`configs/desktop-pywinauto.lock.txt`、`results/a04/pywinauto-install.json`；候选解析报告和摘要在 `results/a04/`。
- 已验证：普通权限下 pip list 正常；pywinauto/comtypes/pywin32 导入及 UIA 初始化成功；pip check 通过。NumPy 2.5.4 保留。
- 代码：`src/desktop_adapter/`、`scripts/desktop_probe.py`，仅提供窗口元数据清单与显式 HWND/PID 的有界只读观测，无输入动作和付费 API。
- 测试：总计 29 项（14 事件 + 8 采集边界 + 7 宿主绑定/诊断）通过，覆盖密码/安全状态未知跳过、跨进程过滤、节点/深度/文本上限、快照绑定、读取异常、UWP 宿主/内容进程绑定和元数据缺失诊断；结果保存于 `results/a04/tests-2026-10-23.txt`。
- 尚未完成：真实指定窗口观测、用户独立核对、同窗低风险动作、延迟/DPI/权限小试及 DSH MCP 接入；不能标记 A04 或 B01 完成。
- 现场进展：用户已打开标准计算器并显示 0。确认计算器由 ApplicationFrameHost 承载，已补充唯一内容子窗口绑定；但工具外层可见 PID 5220，Python 内启动的查询进程报告不存在，列表仍为空。未读取控件正文，也没有把空列表当作“计算器没打开”。诊断与空列表轨迹保留在 `results/desktop/`。
- 下一步：等待用户在 PyCharm 普通终端执行 `scripts/desktop_probe.py list --application calculator` 的输出，以区分执行环境限制与项目问题；取得唯一窗口后再读控件，先不点击或输入。

## 2026-10-23 · 清理与执行环境说明

- 已检查并删除上轮受限测试失败创建的 14 个空 `tmp*` 目录；逐个验证为工作区直接子目录、非联接、内容为空。未清理用户环境或 RAG 文件。
- 开源 wheel 仅作本轮审查缓存；完成版本/哈希/依赖记录后删除项目内下载副本。结果报告、合成日志与依赖锁是正式产物，保留。
- 上轮一条“生成示例 + Windows-MCP dry-run”命令因自动审批用量限制未执行；本轮正常重新申请后已执行成功，没有绕过审批。
- 受限执行环境还会影响 Python 临时目录/SQLite/HTTPS；普通本机权限下测试和依赖核验正常，不把这些工具权限差异归因于项目环境损坏。

## 2026-10-22 · A01 · 完成（运行清单）

- 改动：新增 `docs/runtime_inventory.md`，记录助手解释器、DSH 版本/CLI/profile 配置、RAG 默认启动链、已有接口和环境隔离边界。
- 验证：项目解释器 `-I` 检查、包元数据枚举、pyvenv.cfg；Get-Process 与 EXE 版本；只读解析 app.asar 包元数据；desktop 依赖与 Junction；RAG 启动源码与解释器；本地 GET /openapi.json。
- 结果：助手 Python 3.14.9，仅 pip 25.0.1，隔离系统包；DSH 0.2.1-rc.2；desktop 链接 RAG 工作台 0.10.0；RAG 默认解释器 Python 3.12.4；端口 8000 本次连接拒绝。
- 结果路径：`docs/runtime_inventory.md`，含复核命令和证据来源。不保存可能含敏感数据的完整宿主配置或进程命令行。
- 已知限制：无法获取完整进程父子关系；宿主运行时环境覆盖、profile 工具实时加载情况未确认。候选桌面组件尚未安装或验证，不能声称已完成 A04/B01。
- 安装前待解决：pip list 在本次执行环境读取 Windows 配置目录注册表值时报 WinError 2；标准库包元数据枚举正常。已记录，不把 pip 安装能力标为通过，也未改注册表或重建环境。
- 环境改动：无。未启动 RAG、未调用付费 API、未采集桌面、未安装依赖。
- 下一任务：A02，定义计算器、记事本等场景、外部验收方式与失败分类；随后 A03 事件记录。A04 先只读适配，B01 指定窗口识别验证后再进入动作小试。

## 已确认的执行约束

- 以 `01-助手研发任务拆解与验收.md` 为主线，以用户最新说明修正文档旧信息。
- 用户确认计算器和记事本可以正常打开；需要采集指定窗口时再请用户配合。
- 当前桌面是现场信息来源，操作权限限定到指令指定的测试窗口；自行启动应用后续扩展，记忆并非启动软件的技术前置。
- QQ 在记忆阶段再评估；不先下载视觉大模型、CUDA 或训练数据，不改已收尾的 RAG 环境。
