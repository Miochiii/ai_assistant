# 桌面助手进度与后续计划

- 报告时间：2026-10-27 19:15（UTC+08:00）
- 工作目录：`E:\file\agent\ai assistant`
- 当前定位：**受控单步/多步预演与 P0 现场授权验证已通过；记忆宿主 v1 已 live 加载；运行记录/幂等收尾已离线落地；仍不适合无人看管重放**
- 插件版本：`dsh-desktop-observe` 0.6.5；执行器：0.5.1；动作契约：schema 1
- 当前程序：`notepad-open-file-menu` v2/v3、`notepad-file-menu-toggle` v1（v1 旧记录加载会拒绝）
- 测试状态：Python **236** 项、Node **93** 项通过；十一工具 schema/原生注册检查通过
- 2026-11-01：C1 上下文失效恢复修复：新增 `context_generation`/`refresh_context`、`/memory refresh`；host generation 从核心恢复并随刷新递增；`llm/stream` 改为 best-effort，不再因 needs_refresh 中断 `next()`；记忆工具错误结构化，前端不再只剩 UNKNOWN。修复 register_exposure 可登记已删除记忆的问题。Python **221**、Node **93**、host 单测 13、真实 host 检查 15 通过；checkpoint 已清理为 0。证据 `results/memory/context-recovery-fix-20261101.json`；需要重启加载修复。
- 2026-11-02：Win32 文本接收器延迟选区探测：低完整性观察对 Medium Edit 的 EM_GETSEL 被拒绝，旧逻辑误判 unsupported；观察侧保留 class/style 能力并标 selection_probe=unavailable，Medium 执行器强制当前选区折叠。扩展 RichEdit* 类。Notepad 标准 Edit live 输入 `能力验收abc`，14 事件、可见、第 8 列，未保存/无 Enter。证据 `results/executor/text-receiver-deferred-probe-20261102.json`；Python 236/Node 93。
- 2026-11-02：Coach Host OCR 语义定位：`coach_host.py --locator auto|ocr|patch`；Windows 内置 OCR（zh-Hans-CN），低完整性 helper 用 in-memory WinRT stream 解码 PNG 绕过 StorageFile broker。DSH 实测“新会话”→`[475,256,108,36]`，Next 后 OCR“插件”→`[346,328,93,38]`，鲸鱼 STEP 2/3。无目标输入。证据 `results/executor/coach-host-ocr-20261102.json`、`coach-host-ocr-step1.png`、`coach-host-ocr-step2.png`。
- 2026-11-02：Coach Host 闭环 patch 版：`coach_host.py` + overlay `--event-file/--host-paced`；Next→fresh capture→bounded patch→state，实测“新会话”→“插件” similarity 1.0。证据 `results/executor/coach-host-patch-20261102.json`、`coach-host-step1-visible.png`、`coach-host-step2.png`。
- 2026-11-02：Coach Overlay 视觉与鲸鱼气泡：`DSniang02` 复用，chroma-key 透明修复，独立不透明 Next/Close 控制窗，步骤文字/悬停/入场动效；控制面板与 `window_rect` 失效逻辑保留。证据 `results/executor/coach-overlay-poc-20261102.json`、`results/vision/coach-whale-buttonwin.png`。
- 2026-11-02：Coach overlay 基础：透明置顶/点击穿透/观察 bbox/state-file/旧观察与 generation 失效；`--exclude-capture` mss 排除。证据 `coach-overlay-final.png`、`coach-overlay-bridge.png`、`coach-overlay-exclude.png`。
- 2026-10-29：`desktop_replay` 自动 checkpoint 任务边界已离线接入（memory context + pending + facts + Node refresh）；正式开关未启用、运行中 Node 需重启；证据 `results/memory/replay-checkpoint-integration.json`。
- 2026-10-30：用户已启用 `auto_checkpoint=1`、30 天；首次 live 空白点击生成 saved checkpoint `ec79ed21...`，但 `action.js` 读错字段导致 run `input_delivery=unknown`/facts 为空。修正后第二次点击 run `ed1903b1...` 写入正确 `input_delivery=sent`、一条 fact、checkpoint `46e01782...`，resume 正常；第三次 click `0c373e11...` 写入 `19f3806b...`。`desktop_replay` v4 最终 run `9ef78d59...` 两步完成、`memory_context_available=true`、facts 两条、checkpoint `01b067a6...` saved；replay 边界 live 通过。用户在真实新会话执行 `memory_resume program:notepad-file-menu-toggle:v1`，读回同一 checkpoint，`task_success_verified=false`、`automatic_execution=false`；旧 `ec79...` 已由用户显式清理，余 3 个正确 checkpoint。只读激活 `test.txt` 截图 `7af16d37...` 确认 File 菜单关闭、0 click/0 input。证据 `results/memory/new-session-resume-20261030.json`、`replay-checkpoint-live-20261030.json`、`live-checkpoint-corrected-20261030.json`。
- 2026-10-31：按 GPT 决策实现 C1：`memory_context_exposures`/`memory_context_states`、暴露登记与请求状态检查、revoke/forget/到期失效标记；只存 ID/版本/状态，不存正文。host `recall`/`resume` 已前置检查并登记 metadata-only exposure；`llm/stream` 在提交前用单事务复核并提升 `submitted_to_adapter`，失败不调用 `next()`。live 已验证 recall 后下一次模型请求前 stage 从 prepared 变为 submitted、context clean；同 session needs_refresh 阻断仍待现场。Python 新增 6 项隔离测试，全量 204；Node 80，host 单测 11、真实 CLI host 15。仍缺 C2 自动干净切换、C3 surface 重建、live needs_refresh 阻断；`auto_recall` 仍关闭。Grounding 第二线仍只保留接口，不安装/调用检测器。
- 2026-10-31：统一输入协议 E0 第一/第二/第三切片：拆出 action/observation/receipt schema 常量（值仍为 1）；Node 启动器每次无条件创建取消文件，超时/stdout 超限请求取消并等待退出；Python ActionClient 改为带取消文件的 Popen、宽限后强杀并报 unknown；新增 operation journal，输入前登记 operation_id/digest，输入前标 input_started，结束后 finalized/unknown/refused，重复逻辑操作不再发送输入；默认输入租约改为用户级共享；click receipt 增加 release/pending_or_possible_down。旧 click 回归 211/82 通过。尚未完成键盘持键释放、journal 清理策略和 live 验收；未新增键盘/文本/滚动/拖拽。证据 `results/executor/e0-foundation-20261031.json`。
- 2026-10-31：E1 有限纵向滚动：契约接受 vertical/notches -3..3；executor 使用观察锚点、单次 wheel、显式 scroll grant；旧 click grant 不授权 scroll；默认 grant 仍不含 scroll；receipt 报 `input_api_accepted`、`input_delivery_observed=false`、无按钮释放声明；新增 `desktop_scroll` 工具，复用 run ledger 和自动 checkpoint。Node/原生 schema 通过。证据 `results/executor/e1-scroll-20261031.json`。
- 2026-11-01：E1 live PDF 滚动通过接收器效果检查：Edge PDF `hwnd=657844` 单次 -1 notch；wheel accepted 1、input_events=2、画面变化 0.073081、正文上移；run `bcf94d2a...`、checkpoint `ff2ce8d1...` saved；无 click/无重试/任务成功仍 false。修复 `desktop_click_trial.py` 对含 U+200B 标题的 GBK 输出异常（ensure_ascii=True）。授权已撤销。证据 `results/executor/e1-scroll-live-20261101.json`。
- 2026-11-01：E2 导航键 core/tool：observation binding 增加 host focus evidence；只接受 Left/Right/Up/Down/Home/End，要求 active/focus/root 一致和显式 key grant；win32 press_key 发送一次 keydown/keyup 并记录 release；新增 `desktop_key` 工具，复用 run ledger/自动 checkpoint。Node/原生 schema 通过。证据 `results/executor/e2-key-20261101.json`。
- 2026-11-01：E2 live PDF 导航键：焦点 `active/focus/root=657844`；单次 `Down`，key events 2、input_events=3、画面变化 0.113225，PDF 内容移动到后续题目；run `fea2d944...`、checkpoint `c48d1f03...` saved；无 click/无 text/无重试，任务成功仍 false。完整 2 事件曾被误报 key_release=unknown，已修正为 observed_neutral，未重发。授权已撤销。证据 `results/executor/e2-key-live-20261101.json`。
- 2026-11-01：E2 短文本 core/tool：契约 1..16 Unicode scalars、最多 32 UTF-16 units，拒绝 CR/LF/Tab/控制字符；focus + 显式 text grant 必需；Win32Desktop.insert_text 发送 UTF-16 keydown/keyup 对，部分批次有限清理；receipt 不保存正文，digest 仅绑正文哈希；新增 `desktop_text` 工具，UI 展示 redact。Node/原生 schema 通过。未发送真实文本输入，接收器插入验证未实现。证据 `results/executor/e2-text-20261101.json`。
- 2026-11-01：QQ 文本实测在输入前被阻断：目标 `hwnd=67422`，含 text 的 grant 被运行中旧 Node ACTIONS 判无效，`desktop_activate` 返回 AUTHORIZATION_REQUIRED；0 点击/0 输入/0 文本。磁盘已加入 text 白名单并新增授权回归测试，重启后解决。证据 `results/executor/e2-text-live-qq-blocked-20261101.json`。
- 2026-11-01：E2 live QQ 文本插入：首次点击 INPUT_CHANGED（0 输入），重新观察后点击输入区送达；插入 `测试输入abc`，7 scalars/14 key events，输入框显示文本，无 Enter/无发送；run `e830cdb9...`、checkpoint `399fe9d1...` saved，任务成功仍 false。焦点证据仅顶层 HWND；授权已撤销。证据 `results/executor/e2-text-live-qq-20261101.json`。
- 2026-11-01：E2 双输入区焦点切换与可见文本验证：本地 `two-inputs.html`，同窗口 `hwnd=525416`；一次预览坐标误用导致 API 接受但无变化（未计成功），改正后 Field A=`AAA`、Field B=`BBB`，焦点切到 B；`desktop_text` 输出 `receiver_verification=visual_review_required`，本次视觉记为 `visually_observed`，无 OCR/UIA、无 Enter/表单提交。授权已撤销。证据 `results/executor/e2-two-input-focus-20261101.json`；当前 14 个测试 checkpoint。
- 2026-11-01：E3 受限组合键 core/tool：只接受 `Ctrl+Left/Right`；`chord` grant、focus/foreground、4 事件完整批次和有限清理；新增 `desktop_combo`，复用 run ledger/自动 checkpoint；默认关闭，不接受 Ctrl+A/C/V/X、Alt/Win/Shift、文本/Enter。Node/原生 schema 通过。证据 `results/executor/e3-combo-20261101.json`。
- 2026-11-01：E3 live Ctrl+Left QQ：输入框 `测试文本abc`，点击末尾后发一次 Ctrl+Left，4 事件接受/释放 `observed_neutral`；放大截图显示光标移动到 `本|abc`，文本不变，无 Enter/发送；run `2bb68f5d...`、checkpoint `c63d5972...` saved，任务成功仍 false。授权已撤销。证据 `results/executor/e3-combo-live-20261101.json`；当前 16 个测试 checkpoint。
- 2026-11-01：E4 同窗口受限拖拽 core/tool：start/end 同观察、距离≥8、所有插值点预检、12 步移动、按下/释放批次；部分批次有限释放；新增 `desktop_drag`，显式 drag grant，复用 run ledger/自动 checkpoint；默认关闭，不做跨窗口/文件拖放/修饰键/重试。Node/原生 schema 通过。证据 `results/executor/e4-drag-20261101.json`。
- 2026-11-01：E4 live 文本选择拖拽：本地双输入测试页 `hwnd=1901248`，从 `[125,405]` 拖到 `[1120,405]`，1 按下/12 移动/1 释放，15 事件，release `observed_neutral`；整段说明文字高亮选中，无文件/窗口拖动、无重试。run `2937176f...`、checkpoint `0829224f...` saved，任务成功仍 false；Edge 选择工具条是应用侧效果。授权已撤销。证据 `results/executor/e4-drag-live-20261101.json`；当前 17 个测试 checkpoint。
- 2026-11-01：端到端组合小任务：观察 → Field A 输入 `Alice` → 重新观察 → Field B 输入 `Bob` → 重新观察 → 拖选说明段落；最终截图 A/B 值正确、段落高亮；无 Enter/提交/发送/重试；视觉 `visually_observed`，`task_success_verified=false`。授权已撤销。证据 `results/executor/e2e-two-input-20261101.json`；当前 22 个测试 checkpoint。

---

## 2026-10-26 · 记忆核心宿主接入 v1

- 核心未重写，重新跑 `check_memory_core`：**31 项通过**（新增删除计划绑定和幂等 checkpoint 测试）；报告 `results/memory/core-v1-rerun.json`。
- 新宿主：`plugins/dsh-desktop-observe/memory.js` + `memory-client.js`；包内 `memory-host` 行，不改 profile package.json；固定 SQLite `runtime/memory/memory.sqlite3`。
- 模型工具只有 `memory_recall`、`memory_propose`、`memory_checkpoint`、`memory_resume`；显式写入/确认/修订/撤销/删除只在人类 `/memory` 命令。候选不可见，`forget` 需要 `confirm:true` 和 `plan_id`。
- 来源：真实 `user/message`（source.kind=user）；稳定 ID 哈希；项目 scope 用 session cwd realpath 哈希；超长/空文本不落库。记忆结果只以 `context_only`/`execution_authority=false` 数据标记进入模型，不拼 system prompt。
- 离线验收：核心 31；`check_memory_host.mjs` 10 项（propose/confirm/两会话 recall/history/checkpoint/resume/auto checkpoint 幂等/plan+forget/删除后为空）；`check_dsh_memory.mjs` 四工具+命令 schema/注册通过；Node **78**、Python **198**。
- 边界修复：未知项目拒绝 `PROJECT_UNKNOWN`；召回依赖按用户请求记录；`plan` 返回 `plan_id/data_version`，`forget` 绑定 plan，核心不一致返回 `DELETION_PLAN_CHANGED`。新增 2 核心、2 宿主测试。
- 证据：`results/memory/host-integration.json`、`results/memory/dsh-memory-contract.json`；说明 `docs/memory_host_integration.md`。
- **live 验证**：重启后四个记忆工具已出现；recall none/current 正常；propose 生成候选，current 排除 candidate，history 显示 candidate+真实用户来源；resume 对不存在 task 返回 fresh-observation/no-auto-execute；测试候选 `test.memory_host_live` 已 plan/forget 清理，export 为空。记录 `results/memory/live-host-20261026.json`。
- **两会话 live**：A `cmd-09089916-3` 的 `command/done` 为 `Remembered 93ec5f58-...`；B `cmd-09089916-4` 的 history `command/done` 返回 `目录A`/active；当前会话 `memory_recall` 也返回同一条，证明跨会话 scope 正常。两个新会话 UI 未显示 detached command 结果行；命令已持久化，展示原因未查清。证据 `results/memory/two-session-live-20261026.json`。
- **未验证/未做**：新会话结果行展示原因、真实 `/memory confirm/revise/revoke/forget` UI 流程、新用户消息下的 live checkpoint；自动任务结束触发器、自动检索注入、删除 UI、自然语言写入、图片记忆。
- **运行记录/幂等收尾**：新增 `src/desktop_adapter/runs.py`（5 测试），记录 lifecycle/termination/input_delivery/verification/checkpoint_write，operation_id 幂等，未收尾记录只列出不自动重跑；`preact_replay.py` 已接入并输出 `run_id/run_record`。核心新增 `memory_operations` 与 `save_checkpoint(operation_id=...)`；宿主新增仅 host 可用的 `autoCheckpoint({consent:true,operation_id})`，未注册模型工具、未接触发器。
- **桌面租约/Node 点击**：新增 `src/desktop_adapter/lease.py`（2 测试），执行器输入前获取 `desktop-input.lock`，第二个请求 `DESKTOP_BUSY`；`runs.js` 让 `desktop_click` 前后写 run，`verification=unknown`，ledger 启动失败不发送点击；1 个 fake 执行器测试。跨进程实测 `DESKTOP_BUSY`、0 输入（`results/run-ledger/lease-busy-20261027.json`）；Node ledger 桥合成检查 `results/run-ledger/node-client-check.json`。20:05 重启已加载 0.6.1 的租约/run/autoCheckpoint；后一次重启加载了 0.6.2 的 `desktop_replay`，但 session-id bug 由 0.6.3 修复，0.6.3 尚未重启加载。
- **`/memory help` UI 已确认**：`/memory` 点选后是蓝色命令 chip，`help` 为白色参数，发送后以 `>- memory · Usage...` detached row 显示，不是弹窗；长文本被行宽截断，重复发送会重复行；help 不写记忆/来源。
- **视觉效率 P0/P1**：`vision.capture` 增加 capture/encode/persist 拆分计时；action-ready 增加 identity/manifest/binding/observe 计时；附件增加 read/hash/save/receipt 计时；PreAct 步骤增加 locate/verify 计时。新增 `observation_policy.py` 纯函数变化检测（几何/窗口身份/精确 RGB/32×32 块/critical/omitted）和 `ShadowTracker`；`benchmark_capture.py`、`compare_observations.py` 可离线测量，不改点击行为。10 个策略/计时测试通过。
- **视觉 live smoke**：记事本 `hwnd=985238`、区域 `(200,250,400,300)`，仅 observe 授权后撤销。直接 capture 5 次中位 7.59/1.22/0.95 ms；action-ready 完整 Python 观察 68.48/69.35 ms，内部 capture 10–12 ms；两帧 unchanged。带图样本：PNG 4,622 bytes，capture 8.05 ms，工具调用 297 ms，工具结果到下一 assistant message 6,008 ms；模型处理段远大于本地截图。未发送点击。证据 `results/vision-efficiency/notepad-live-p0-20261027.json`、`notepad-image-latency-20261027.json`。
- **P2 desktop_replay**：新增 `replay.js` 和 `desktop_replay` 工具（3 个 Node 测试），只接受已验证程序 ID/版本，不接受坐标/代码/动作数组；一次宿主调用内部执行 preflight/observe/locate/execute/verify，失败/unknown 停止；当前单步，Python proof/授权/租约不变；返回紧凑结果、run_record、证据路径。真实无授权冒烟返回 `AUTHORIZATION_REQUIRED`、0 输入/截图。真实单步验收在授权后 locate found [32,47]，执行器因 `FRAME_CHANGED` 在输入前拒绝：0 click、0 input、0 receipt，未打开菜单；replay session-id bug 已修复（0.6.3），FRAME_CHANGED 稳定性/区域策略待做，当前不算成功。证据 `results/desktop-replay/no-grant-smoke-20261027.json`、`frame-changed-20261028.json`。
- **W3 有限定位/B03 对齐**：`locate_patch` 升级为 `bounded_patch_search_v2`，解除整图同尺寸限制；basis 参考补丁 + fresh 有界搜索，支持最多 8 个 0.5–3.0 尺度、`search_center`、20k 候选上限；返回 found/ambiguous/not_found/unsupported。PreAct 新程序可声明 `region_space=client|window`、`scale_candidates`、`search_center`，旧 v2 保持单尺度。B03 新增 `template_region`/`after_region` 与各自 critical region。Live v3 proof：可见外框 `[110,22,1255,903]`、target `[17,58]`，locator found 1.0/margin 0.334；整图 B03 被 1.5% 菜单变化骗过，绑定 `[0,35,400,350]` 后前置 failed 0.875736、after passed 0.999779；v3 已保存，程序 `expected_matched=true`。重启后新窗口偏移 1px，`desktop_observe region_space=window` 返回可见外框，`desktop_replay` v3 通过：locator 0.998828/margin 0.332812、B03 after 0.999779、`program_condition_verified=true`、`task_success_verified=false`。窗口缩小到可见外框 `820×618`（DPI 仍 144）后，PreAct `clipped_to_current_window=true` 截取当前外框，v3 replay 仍完成，locator 0.996094/margin 0.332812、B03 after 0.999564。`window` 区改为 DWM 可见外框；executor stdin 改 UTF-8。全量 Python **179**、Node **43**；未做 100/125/150% DPI 三档验收，v3 仍单尺度 `[1.0]`。证据 `results/localization/w3-v3-proof-20261028.json`、`results/desktop-replay/v3-live-window-bridge-20261028.json`、`results/desktop-replay/v3-small-window-20261028.json`。
- **帧稳定性/有界 settle**：Notepad 静止时 16 帧/约 1.8s 的整帧与目标框变化均为 0；执行器输入前最多 5 次、间隔 30ms 重新抓帧，匹配才继续，仍失败 `FRAME_CHANGED`；不重试动作。测试新增“两次变化后稳定 → 一次点击”“持续变化 → 0 点击”。Python **179**、Node **43**。证据 `results/localization/frame-stability-20261029.json`。
- **W4 多步实验**：新增 `notepad-file-menu-toggle/v1` 两步程序（打开 File → 关闭 File），两步 basis 分别为菜单关闭/打开，B03 分别用打开/关闭模板。`verify_program` 完成两步（2 observation IDs、2 receipts、proof）；独立 `preact_replay.py` 重跑 `completed`，2 steps found、2 receipts、run record `passed`，B03 0.999564/0.986443，窗口缩小后两步 `clipped_to_current_window=true`。早先一次因 QQ 抢前台被 `INPUT_CHANGED` 安全拒绝（0 click/0 input），关闭 QQ 后重跑通过。host bridge 已开放最多 8 步并在重启后通过 v4 host 实测：2 steps、2 receipts、`program_condition_verified=true`。失败实验：step1 打开菜单、step2 越界目标 `TARGET_NOT_FOUND`，菜单保持打开、无自动回滚；cleanup click 才关闭。修复失败路径丢失 prior receipts，结果保留 1 个 step1 receipt，Python 测试增至 178。证据 `results/desktop-replay/host-multistep-20261029.json`、`results/localization/w4-step2-failure-20261029.json`。
- **W5 前台切换安全**：Notepad action-ready 观察后切到 Harness 前台，再点击被 `FOREGROUND_CHANGED` 拒绝，0 click/0 input；恢复 Notepad，0 input。证据 `results/localization/w5-foreground-change-20261029.json`。
- **W5 重复窗口歧义**：两个 Notepad（`test.txt`、`2606.07624v1.txt`）同时存在，仅按 `class_name=Notepad` 的 draft 返回 `WINDOW_AMBIGUOUS`，未激活/观察/输入、0 receipts。证据 `results/localization/w5-duplicate-window-20261029.json`。
- **W5 两窗口精确 title**：两个 Notepad 不重叠；v3 精确 title 只选 `test.txt`，完成 run `98ff932e...`，无 action/observation 引用另一窗口。replay 后目标失去前台，cleanup 首次被拒；单独授权临时置前后关闭菜单，恢复另一窗口前台。没有保留另一窗口 before/after 像素哈希，不声称像素不变。
- **W0/W1 窗口上下文**：`FRAME_CHANGED` 增加局部诊断；新增 `window_context.py`，自建 per-monitor DPI 上下文读取外框、DWM 可见外框、客户区、显示器交集、DPI/awareness、进程创建时间/session、geometry_revision。`desktop_windows`、action-ready observation/binding、executor 校验、PreAct 步骤接入；观察前后几何变化丢弃观察。只读，不改点击区域/授权/输入。Live Harness 窗口 1941×1243 外框、1919×1232 客户区、DPI 144、per-monitor；UWP 读取失败显式记录。证据 `results/window-context/live-context-20261028.json`。
- **W2 客户区/窗口区**：`desktop_observe` 增加 `region_space=client|window|explicit`；hwnd 无 region 默认 client，region 存在默认 explicit；client/window 从当前客户区/外框原点开始，不加固定 margin；observation/binding 记录并校验。执行器输入前重读窗口上下文，身份/geometry revision 变化 `WINDOW_CONTEXT_CHANGED`。PreAct 新程序支持 `visual_basis.region_space=client|window`，旧 v2 保持 legacy outer+margin，不破坏旧 proof。修掉执行器 `window` 未赋值和回执 JSON 截断；`EXECUTOR_BAD_OUTPUT` 带 stderr/exit。Live：默认 client 观察 1253×827，工具路径空白点击成功（1 click/3 input、input_delivered、post delta 0），移动后客户区原点 [178,140]，缩放后 948×603，恢复 1253×827；证据 `results/window-context/w2-live-acceptance-20261028.json`。前两次失败回执不完整，不认证零输入；W3/W4 proof 和 live replay 已完成，见下。

---

## 一、结论先行

目前已经形成一条可审计的受控链路：

```text
任务授权
  → desktop_windows / desktop_activate
  → action-ready 观察（新 observation ID + 窗口绑定 + RGB 基线）
  → 目标补丁限定区域重定位
  → ActionClient 请求（grant_id + 图片像素目标）
  → 固定 Medium 执行器（窗口/前台/帧/指针/输入复核）
  → 一次点击 + 动作后截图 + post_action_delta
  → B03 区域模板验证
  → 程序 proof / 重放结果 / 保留策略
```

已经做到：

- 真实点击成功，但不把“输入送达”当任务成功；
- 程序必须带内容绑定 proof 才能加载/重放；
- 验证器只接受明确的 `passed`，`unknown`/布尔/格式错误都停止；
- 取消、回执真实性、模板/依据绑定、任务授权、保留策略都有代码和测试；
- 目标定位从固定坐标升级为限定邻域搜索，歧义会停止；
- 多步程序先 preflight 全部窗口/授权/依据/区域，全部通过才动作。

仍然不能声称：

- 无人看管重放安全；
- B03 能理解业务语义；
- 任务授权能防同一用户下的恶意本地代码；
- 多步失败可回滚；
- 记忆功能已完成（schema 等 Astra 方案）。

---

## 二、当前架构

| 层 | 位置 | 职责 |
| --- | --- | --- |
| DSH 工具 | `plugins/dsh-desktop-observe/index.js` | 注册六个工具；`desktop_windows` 附带授权摘要 |
| 图像/授权/动作桥 | `image-delivery.js`、`authorization.js`、`action.js`、`bridge.js` | 截图、授权选择、请求构建、取消传播 |
| 动作契约 | `src/desktop_adapter/action_contract.py` | 请求/观察/目标/授权的严格校验 |
| 固定执行器 | `src/desktop_adapter/executor.py` | 唯一发送鼠标输入的进程；Medium、一次点击、无重试 |
| 动作客户端 | `src/desktop_adapter/action_client.py` | 从 pyvenv 解析 base Python，启动执行器 |
| 任务授权 | `src/desktop_adapter/authorization.py`、`scripts/authorize_task.py` | 窗口身份、动作、session、有效期 |
| 程序库存 | `src/desktop_adapter/inventory.py` | 草稿/verified、proof 校验、重放状态机 |
| proof | `src/desktop_adapter/proof.py` | 内容绑定 HMAC；模板/依据/运行回执 |
| B03 | `src/desktop_adapter/verify.py` | 区域模板比较，`passed/failed/unknown` |
| 重定位 | `src/desktop_adapter/locate.py` | 半径 64、stride 4；best/second 分离与 margin |
| 保留 | `src/desktop_adapter/retention.py`、`scripts/cleanup_evidence.py` | 普通证据/附件 TTL，程序依据/模板保留 |
| PreAct | `scripts/preact_adapter.py`、`scripts/preact_replay.py` | 按步 preflight、activate/observe/locate/execute/verify |

---

## 三、已完成内容

### 3.1 执行器与安全边界

- 执行器必须 Medium 完整性；项目 `.venv\Scripts\python.exe` 是 Low，会被拒绝，实际从 `pyvenv.cfg` 的 `base-executable` 启动。
- 执行器只允许左键单击，一次观察只允许一次点击，无自动重试。
- 执行前复核：观察 ID、图片哈希/尺寸/原点、窗口身份、前台、输入 tick、像素帧、目标覆盖/指针移动。
- 动作后异常保留 `gui_clicks_attempted` / `input_events_sent`，返回 `unknown_after_input`，不再清零。
- 取消：Node 启动器写取消文件，Python 在输入前/按键前检查；取消/超时等待子进程退出；无法确认时返回 `cancelled_unknown`，不重试。
- 取消后的按键释放没有保证；目前没有现场证据表明发生过按住不放。

### 3.2 程序库存与验证

- 外部 `parse_program` 只能创建草稿；`save_program`/`load_program` 校验内容绑定 HMAC proof。
- proof 绑定：程序内容、视觉依据哈希、模板哈希、执行器/验证器版本、运行回执哈希。
- 模板/程序内容/运行回执任一改动，proof 失效。
- 首个程序已从 v1 迁移为 v2（proof-bound）；v1 加载返回 `PROGRAM_PROOF_MISSING`。
- 重放只接受 `status == "passed"`；failed/unknown/布尔/格式错误都停止。
- B03 前增加 before-image 检查：动作前已经满足目标 → `unknown`，不判成功。
- 程序视觉依据哈希在适配器再次核验；模板路径限制在 `runtime/templates`。

### 3.3 任务授权

- 用户 CLI：`scripts/authorize_task.py --hwnd ... --actions ... --ttl ... --task ...`。
- 授权绑定：`hwnd`、`pid`、`class_name`、`title`、动作集合、Harness session、Windows session、有效期、可选程序 ID。
- 执行点：
  - `desktop_activate` 按 hwnd 选择 `activate` 授权；
  - 带 hwnd 的 `desktop_observe` 选择 `observe` 授权；
  - `desktop_click` 从观察绑定选择 `click` 授权，并把 `grant_id` 放进请求；
  - PreAct 在激活前选择 `replay` 授权；
  - 固定执行器再核对 grant 的窗口、动作、过期、Windows session。
- 没有授权返回 `AUTHORIZATION_REQUIRED`；窗口/动作越界拒绝。
- 真实样本：Notepad `hwnd=788882`，授权 `ebfc1f5b-37f7-4654-b3d9-030be485e8b8`，1 小时，四个动作；v2 重放完成，执行器回执含 `authorization.grant_id`。
- 授权文件是本地事故边界，不是签名；防模型/PreAct 误操作越界，不防同用户任意本地代码改写授权文件。

### 3.4 证据保留

- `configs/retention.json`：
  - 普通 vision 24h；
  - RGB 1h；
  - 程序视觉依据/模板长期保留；
  - Harness 附件 24h，只删 `runtime/attachments.jsonl` 索引内副本；
  - `memory_images=false`。
- 图片交付成功后尽力追加 `runtime/attachments.jsonl`；索引写失败不阻塞交付，但该附件不会被自动清理。
- `scripts/cleanup_evidence.py` 默认 dry-run；只允许删除 `results/vision` 和 `~/.dsh/attachments/v1/objects` 内计划路径。
- 首次 dry-run：6 个普通 vision 目录待删、30 个保留、0 错误；**尚未执行 `--apply`**。

### 3.5 重定位与多步

- `locate.py` 在存储目标周围半径 64、stride 4 搜索；best 必须 ≥0.98，且与分离的 second 差距 ≥0.005；否则 `not_found`/`ambiguous`。
- 真实重放从旧 `[22,47]` 定位到 `[32,47]`（相似度 0.9867，second 0.6269，margin 0.3598），仍点到“文件(F)”；B03 `passed` 0.994179。
- 多步：所有步骤先 preflight 窗口/授权/依据/区域；每步重新 activate/observe/locate/execute/verify；中途失败停止，不回滚已完成步骤；没有分支/循环。
- 单步 v2 在多步重构后又真实重放一次：`completed`、B03 0.994179、菜单关闭。
- 没有真实多步桌面样本，只有单元测试。

### 3.6 测试与检查

- Python **141** 项通过（`unittest discover -s tests`）。
- Node **36** 项通过（观测 5、图片 11、动作 8、置前 3、授权 2、记忆宿主 7）。
- 六工具 schema/原生注册检查通过：`desktop_monitors`、`desktop_windows`、`desktop_activate`、`desktop_observe`、`desktop_click`、`desktop_replay`。
- 检查命令记录：

```powershell
& '.\.venv\Scripts\python.exe' -B -m unittest discover -s tests
node --test --test-isolation=none tests\test_desktop_observe.mjs tests\test_image_delivery.mjs tests\test_desktop_action.mjs tests\test_desktop_activate.mjs tests\test_authorization.mjs
$env:ELECTRON_RUN_AS_NODE = '1'
& 'E:\dsh\DeepSeek Harness.exe' scripts\check_dsh_observe.mjs
```

---

## 四、关键证据

### 4.1 当前程序与 proof

- `runtime/programs/notepad-open-file-menu/v2.json`
- `runtime/keys/program-proof.key`（本地 HMAC 密钥，不提交/不公开）
- v1 是 legacy，加载被拒绝。

### 4.2 最终 v2 真实重放

- 结果：`results/b02/single-click-20261025/replay-v2-final.json`
- B03：`results/b02/single-click-20261025/b03-v2-final.json`（passed 0.994179）
- 动作后图：`results/vision/e0ee98c5-c79c-4ba9-a721-ed424dd5ded1/screen.png`
- 菜单关闭：`results/b02/single-click-20261025/v2-final-menu-closed.png`
- 定位结果：`found`，new_center `[32,47]`
- 回执：1 次点击、3 个事件、`expected_matched=true`、grant_id 存在

### 4.3 授权重放

- 结果：`results/b02/single-click-20261025/replay-grant-v2.json`
- B03：`results/b02/single-click-20261025/b03-grant-v2.json`（0.994782）
- 菜单关闭：`results/b02/single-click-20261025/grant-menu-closed.png`

### 4.4 重定位/多步摘要

- `results/b02/single-click-20261025/multi-step-relocation-summary.json`
- `results/b02/single-click-20261025/authorization-retention-summary.json`
- `results/b02/single-click-20261025/preact-v2-security-summary.json`

### 4.5 早期 live 证据

- `results/b02/single-click-20261025/live-activate-20261025.json`
- `results/b02/single-click-20261025/b03-live-activate.json`
- `results/b02/single-click-20261025/action-chain-live.json`
- `results/vision/49236b35-.../observation.json`
- `results/vision/beb2aaf2-.../screen.png`

注意：这些是**新授权代码加载前**的旧插件现场链路；新授权检查要在重启 Harness 后才会在这五个工具里生效。

---

## 四·补充：P0 现场验证结果（22:16–22:19）

重启后确认新插件已加载：`desktop_windows` 返回 `authorization_grants`，旧授权 `ebfc1f5b-...` 仍在有效期。随后完成受控现场链路：

- `desktop_activate(hwnd=788882)`：`foreground_confirmed`，0 输入。
- 无授权窗口 `desktop_activate(hwnd=327982)`：被拒绝，未聚焦。
- 对齐区域 `[60,88,400,300]` 的 `desktop_observe` → `desktop_click`：
  - 观察 ID `64212707-8cf1-43ac-87e2-9eb20f3da03b`；
  - 目标 [22,47] → 桌面 [82,135]；
  - 1 次点击、3 个事件、`input_delivery_observed=true`；
  - 回执 `phase=after_input`、`stage=done`、`authorization.grant_id=ebfc1f5b-...`；
  - 回执文件：`results/vision/b6d466c1-6617-4393-8c62-07773d3a2929/action-9ed5a9c0-5d43-4c5c-848a-fc9e3460aa30.json`。
- 动作后 B03：`passed`，相似度 **0.994526**；证据 `results/b02/single-click-20261025/b03-live-grant-p0-phase.json`。
- 菜单已关闭：`results/b02/single-click-20261025/p0-phase-menu-closed.png`。

现场也暴露了一个模板对齐问题：

- 第一次用 `[55,83,400,300]` 观察，与模板原点 `[60,88]` 错位 5px，B03 得到 `failed 0.755718`；这是**假阴性**，不是点击失败。
- 改用 `[60,88,400,300]` 后 B03 `passed 0.994526`。说明 B03 模板必须和观察区域原点绑定；跨区域使用会误判。

PreAct v2 最终在授权下完成（先暴露 hover 问题，再加边缘回退）：

- 初始 `replay-p0-restart.json`：`replan_required / TARGET_NOT_FOUND`，raw 相似度 0.474；原因是程序目标补丁包含“文件”菜单项背景，鼠标 hover 使白底变蓝底。适配器正确未点击。
- 修复：`locate.py` 增加 `edge_iou` 回退，比较边缘轮廓，忽略平坦背景色；必须有分离的 second 和 margin，不放宽 raw 阈值。
- `replay-p0-edge.json`：`completed`，`edge_iou` 定位到 [32,47]，edge 0.9376，second 0.3266，margin 0.6110；授权点击、`phase=after_input`；B03 **passed 0.994526**；菜单已关闭。
- 证据：`results/b02/single-click-20261025/replay-p0-edge.json`、`b03-p0-edge.json`、`p0-edge-menu-closed.png`。
- B03 通用加固：`verify.py` 支持可选 `critical_region`/`critical_tolerance`/`max_critical_changed`；关键文字区域的 1px 改动即使总相似度 0.99 也会 failed，区域外改动不误报。现场菜单 critical 0.0、passed 0.994526，证据 `b03-critical-region.json`。CLI 参数已加。

其他验证：

- `runtime/attachments.jsonl` 已有 6 条交付记录，保留 dry-run 读到 6 条附件。
- 保留 dry-run：6 个普通 vision 目录待删、49 个保留、6 个附件保留、0 错误；**没有执行 --apply**。
- 新增摘要：`results/b02/single-click-20261025/p0-restart-live-summary.json`。
- 测试：Python **141**、Node **36**；六工具 schema/注册检查通过。

---

## 五、当前限制与风险

| 风险 | 现状 | 影响 |
| --- | --- | --- |
| 运行中的 Harness 已重启 | 新授权/保留/重定位代码已加载；`desktop_windows` 返回 `authorization_grants` | 当前工具链已执行新授权检查；重启前的旧证据只作历史 |
| 授权文件非签名 | 本地 CLI 写 JSON，`--yes` 可跳过确认 | 防误操作，不防同用户本地代码改写 |
| proof 密钥本地 | `runtime/keys/program-proof.key` | 防外部 JSON/工具输入伪造，不防同用户任意代码读取 |
| B03 非语义 | 区域模板相似度 | 关键文字替换、相似弹窗、双目标歧义仍可能漏过 |
| B03 原点敏感 | 模板与观察区域必须同原点 | 区域错位会产生假阴性（现场 [55,83] 对 [60,88] 得到 0.7557；对齐后 0.9945） |
| 目标补丁对 hover 敏感 | 已加 `edge_iou` 回退；原始 hover raw 相似度 0.474，edge 0.9376 找到 [32,47] | 真实样本通过，但边缘匹配仍需多主题/DPI 评估；搜索仍有半径 64 限制 |
| 重定位有界 | 半径 64 | 超出范围的布局变化会停止；不是全屏 grounding |
| 多步无回滚 | 中途失败停止 | 已完成步骤的输入不会撤销 |
| 取消后按键释放 | 强制终止无保证 | 极端情况下可能留下按下状态；无现场证据 |
| 保留只覆盖索引附件 | 只删 `runtime/attachments.jsonl` | 历史/其他工具附件不会自动清理 |
| 无人看管重放 | 未达到 | 目前只适合受控、可观察、单步/预演多步 |

---

## 六、后续计划

### P0：让新代码真正生效（已完成）

- [x] **重启 Harness**：`desktop_windows` 已返回 `authorization_grants`，新插件加载。
- [x] **授权可用**：旧授权 `ebfc1f5b-...` 仍在有效期，现场直接使用；过期/换 session 需重跑 `authorize_task.py`。
- [x] **现场工具链**：`desktop_activate` → `desktop_observe`（[60,88,400,300]）→ `desktop_click`；回执含 grant_id，1 次点击/3 事件，`phase=after_input`，B03 0.994526。
- [x] **无授权拒绝**：`desktop_activate(hwnd=327982)` 被拒绝，未聚焦。
- [x] **B03 原点教训**：`[55,83]` 对 `[60,88]` 得到 false negative 0.7557；对齐后 0.9945。模板必须和观察区域原点绑定。
- [x] **PreAct v2 授权重放**：先暴露 hover 补丁问题并正确停止；加 `edge_iou` 回退后 `completed`，B03 0.994526，grant_id 存在。
- [x] **保留 dry-run**：6 个普通 vision 待删、49 个保留、6 个附件、0 错误；未执行 `--apply`。
- [x] **附件索引**：`runtime/attachments.jsonl` 已有 6 条记录，清理计划只覆盖索引路径。

**P0 剩余**：无阻断项。下一步进入 P1（B03 语义边界、授权加固、真实多步样本、保留调度）。

### P1：验证与授权加固

1. **hover/外观不变的目标补丁**：已加 `edge_iou` 回退（hover 真实样本通过），但仍需多主题/DPI/动画样本评估边缘误匹配；安全归位指针策略未做。
2. **B03 负样本矩阵**：错误菜单、相似弹窗、关键文字替换、两个相同目标、遮挡、DPI/主题变化、动作前已满足。
   - 已做：critical region（关键文字 1px 改动 failed）、遮挡/大改动 failed、尺寸变化 unknown、动作前已满足 unknown。
   - 仍做：相似弹窗、两个相同目标（locate 已有 ambiguous）、DPI/主题真实样本；通用 OCR 暂不做。
3. **双目标歧义**：已由 `locate_patch` 的 best/second 处理，补真实/合成样本与阈值说明。
4. **全屏/大范围重定位**：先限定窗口内搜索，再做多候选；不要一次放开到全屏。
5. **真实多步样本**：选两个安全步骤（例如打开菜单→关闭，或新建窗口→聚焦），记录每步窗口/授权/区域/B03；验证第二步失败时不误重试第一步。
6. **授权加固**：
   - 用户级确认（UI 提示/系统确认），减少 `--yes`；
   - 授权签名/HMAC 或系统级密钥，至少让外部 JSON 不能自行造授权；
   - 动作次数/窗口标题实时复核；
   - 过期提醒/自动清理。
7. **取消/超时**：补真实长动作的取消测试；确认子进程退出后没有按键残留；必要时执行器自己释放已按下的键。
8. **保留**：定时 dry-run/apply；附件索引失败告警；记忆图片默认关闭的策略保持。

### P2：记忆与 PreAct 产品化（等 Astra 方案）

1. **记忆 schema**：任务、程序 ID/版本、窗口身份、回执/验证引用、时间、结果状态、用户可见摘要。
2. **写入策略**：默认结构化结果，不存原图；图片只在明确晋升为程序依据/模板时长期保留；用户可删除。
3. **检索**：按任务/窗口/程序检索；命中后仍需重新观察/重定位，不复用旧坐标。
4. **证据关联**：记忆条目引用 proof/run/B03，不把“B03 passed”写成“业务成功”。
5. **PreAct UI/调度**：把适配器接到界面/调度器；只有 P0/P1 的授权、取消、B03 边界稳定后，才考虑无人看管。
6. **评测**：多窗口/多主题/不同 DPI/不同语言/失败恢复；至少 20 个受控样本，记录成功率与停止原因。

---

## 七、需要确认的决策

1. 是否现在重启 Harness 并做一次新授权现场验证？
2. 是否允许执行保留 `--apply` 删除 6 个旧普通 vision 目录（会删除旧截图证据）？
3. B03 的语义边界：接受“区域模板 + 人工核对”，还是投入 OCR/语义验证器？
4. 记忆方案等 Astra 的具体 schema；在此之前不写记忆代码。

---

## 八、命令速查

```powershell
# Python / Node 测试
& '.\.venv\Scripts\python.exe' -B -m unittest discover -s tests
node --test --test-isolation=none tests\test_desktop_observe.mjs tests\test_image_delivery.mjs tests\test_desktop_action.mjs tests\test_desktop_activate.mjs tests\test_authorization.mjs

# 六工具 schema/注册
$env:ELECTRON_RUN_AS_NODE = '1'
& 'E:\dsh\DeepSeek Harness.exe' scripts\check_dsh_observe.mjs

# 任务授权
& '.\.venv\Scripts\python.exe' -B scripts\authorize_task.py --hwnd 788882 --actions activate,observe,click,replay --ttl 600 --task "受控验证"

# PreAct v2
& 'C:\Users\Mio\AppData\Local\Python\pythoncore-3.14-64\python.exe' -B scripts\preact_replay.py --program-id notepad-open-file-menu --version 2

# 保留 dry-run（默认不删）
& '.\.venv\Scripts\python.exe' -B scripts\cleanup_evidence.py
```

---

## 九、文件索引

- 进度：`docs/progress.md`
- 动作协议：`docs/desktop_action_protocol.md`
- PreAct 接口：`docs/preact_interface.md`
- 任务授权：`docs/task_authorization.md`
- 保留策略：`docs/retention.md`
- 工具 README：`plugins/dsh-desktop-observe/README.md`

---

**一句话总结**：固定执行器、proof、三态验证、取消/回执、任务授权、保留策略、限定重定位、hover 边缘回退、多步 preflight、记忆宿主 v1、运行记录/幂等收尾、桌面输入租约、视觉 P0/P1 shadow、多步 `desktop_replay`、W0/W1 窗口上下文、W2 客户区/窗口区、W3 有界多尺度定位/B03 区域对齐和 v3 proof 都已落地，并通过 198/78 测试；W2 已实机通过默认 client 空白点击和移动/缩放观察；W3 已用可见外框 File 菜单生成 v3 proof（B03 前置 0.875736、after 0.999779），重启后 1px 偏移仍通过，窗口缩小到 820×618 时按 `clipped_to_current_window` 截取当前外框仍通过；W4 已用两步程序（打开/关闭 File 菜单）完成 `verify_program`、独立 `preact_replay.py` 和 host `desktop_replay`，两步 B03 0.999779/0.986364，host 最多 8 步；失败实验确认 step2 `TARGET_NOT_FOUND` 后菜单保持打开、无自动回滚，且失败结果保留 step1 receipt。帧稳定性实测 16 帧/约 1.8s 全 0 变化；执行器增加最多 5 次、30ms 间隔的有界 settle，不重试动作；W5 前台切换实验确认 Harness 抢前台时 `FOREGROUND_CHANGED`、0 click/0 input；两个 Notepad 同时存在且仅按 class 匹配时返回 `WINDOW_AMBIGUOUS`，0 input；精确 title 只选 `test.txt`，另一窗口无 action/observation 引用。记忆自动化第一批已离线接入 `desktop_click`，`desktop_replay` 现在也离线接同一 run ledger/memory context/pending checkpoint；正式开关未启用。下一步做相似弹窗/双目标负例、用户启用后的两会话现场验收、自动检索/受限检索，仍不建议无人看管重放。
