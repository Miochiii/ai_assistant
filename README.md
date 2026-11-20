# 桌面智能助手（研发中）

2026-10-30：磁盘插件 **0.6.5** 的记忆自动化第一批已在本项目 live 验收 `desktop_click` 与 `desktop_replay` 的任务终结 checkpoint；用户已启用 `auto_checkpoint=1`、30 天，`auto_recall` 仍关闭。自动检索/注入、完整两会话导航和 replay 嵌套取消恢复仍未完成。实现、开关与证据见 [记忆自动化](docs/memory_automation.md)。下文保留较早阶段的验收记录。

**最高层路线约束见 [项目目标与路线约束](docs/project_goals.md)。** 当前主线是通用底座跨软件闭环；第二条线只保留接口。

当前范围：通用桌面截图与只读视觉识别，以计算器、记事本作为验收样本。按用户最新决定采用视觉优先路线，不继续为每个软件扩充进程名/控件识别逻辑。规划见 `01-助手研发任务拆解与验收.md`；实际进度见 [docs/progress.md](docs/progress.md)。后续按顺序加入受限操作、跨会话记忆和可解释评价。

环境为本项目 `.venv`，Python 3.14.9。原 RAG 项目和环境独立运行。截图入口不调用模型；另有受预算约束的独立 Flash 试验脚本，首轮试验已完成并关闭。当前已有固定动作执行器（v0.5.0，单次受限左键点击）并已注册为本地插件工具 `desktop_windows` / `desktop_activate` / `desktop_observe`（`hwnd` 模式）/ `desktop_click` / `desktop_replay`，六个工具均在本机插件中定义；运行中加载以重启后工具列表为准。没有应用启动或后台自启动能力。

## 记忆核心 v1（2026-10-25）

已实现独立 SQLite MemoryGateway：带来源的显式写入/候选确认、版本与有效时间、用户/项目隔离、当前/历史/字面检索、级联删除和跨会话任务检查点。31 项离线开发回归通过；Harness 宿主 v1 已接入（见下），未启用自动抽取/自动 promote。使用标准库，不改动 RAG 环境。

协议和限制见 [记忆契约](docs/memory_contract.md)，后续插件接入见 [交接说明](docs/memory_handoff.md)。在项目目录运行零费用验收：

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\check_memory_core.py --output results\memory\core-v1.json
```

## 本地验证

插件源码已更新至 0.5.1。`/desktop-check` 的实际宿主连接已通过；下次重启后输入 `/desktop-offline`，从候选列表点击执行零费用隔离会话自检，不加参数。候选未出现时不要作为普通聊天发送。`/desktop-trial` 可查看状态；在线 `run` 仍关闭，需新的具体批准。详见 [受限会话入口](docs/restricted_session_entry.md)。

在项目目录的 PowerShell 中运行：

```powershell
& '.\.venv\Scripts\python.exe' -B -m unittest discover -s tests -v
& '.\.venv\Scripts\python.exe' -B scripts\demo_events.py
```

事件示例使用合成数据，不能视为真实桌面任务效果。说明见 [事件契约](docs/event_contract.md)。

## 固定动作执行器（0.5.0）

动作、坐标、完整性和程序库存边界见 [桌面动作协议](docs/desktop_action_protocol.md)。自检不会点击：

```powershell
node scripts\run_desktop_executor.mjs --self-check
```

Harness/Node 通过 `.venv\pyvenv.cfg` 的 `base-executable` 启动 Medium 执行器；不要直接用 `.venv\Scripts\python.exe`（本工作区中是 Low 完整性，会被执行器拒绝）。规划和后续 PreAct 只能调用 `ActionClient` / Node `click` 这一入口；程序库存只接受带内容绑定 proof 的重跑验证记录，外部输入默认只能建草稿，状态不匹配时停止重放而不是复用旧坐标。

插件 0.6.4 的完整链路：`desktop_windows` → `desktop_activate`（目标不在前台时切换并回读前台）→ `desktop_observe`（带 `hwnd`，生成 action-ready 观察）→ `desktop_click`（图片像素目标）→ 动作后截图、`post_action_delta` 和 B03 模板验证。`desktop_replay` 只接受已验证程序 ID/版本，一次宿主调用内部完成 preflight/observe/locate/execute/verify，失败/unknown 停止；当前只开放单步程序。脚本链路和运行中 Harness 的模型驱动链路均已实测真实点击：脚本目标 [22,47]→桌面 [369,113]；现场 `desktop_activate` 返回 `already_foreground`（0 输入），目标 [22,47]→桌面 [82,135]，动作后截图确认菜单展开，现场 `post_action_delta=0.664683`，B03 `passed`（0.994782）。PreAct 适配层 `scripts/preact_adapter.py` + `scripts/preact_replay.py` 已完成 proof-bound v2 重放：`inventory.replay` 状态 `completed`，B03（含 before-image 因果检查）`passed` 0.994782；v1 是无 proof 旧记录，加载会被拒绝。目标定位已从固定位置升级为限定邻域补丁搜索（`src/desktop_adapter/locate.py`，半径 64/stride 4，not_found/ambiguous 停止）；真实重放从 [22,47] 重定位到 [32,47]，B03 0.994179；多步程序要求所有步骤在动作前通过窗口/授权/依据 preflight，中途失败不回滚。重启后现场 live chain 已通过（grant_id 回执、B03 0.994526）；PreAct v2 先暴露 hover 目标补丁问题并正确停止，加 `edge_iou` 回退后完成（edge 0.9376，B03 0.994526）。任务授权已加入：`scripts/authorize_task.py` 为 Notepad 创建 1 小时授权，v2 在授权下重放完成，执行器回执含 grant_id；证据 `replay-grant-v2.json`、`b03-grant-v2.json`、`replay-relocate-v2.json`、`b03-relocate-v2.json`。证据 `results/b02/single-click-20261025/action-chain-live.json`、`live-activate-20261025.json`、`b03-live-activate.json`、`replay-notepad-open-file-menu-v2.json`、`b03-preact-v2.json`、`preact-v2-security-summary.json`。普通截图/RGB 与 Harness 附件按 `configs/retention.json` 短期保留，`scripts/cleanup_evidence.py` 默认 dry-run；授权/保留说明见 `docs/task_authorization.md`、`docs/retention.md`。`image_attachment_enabled` 已按用户要求长期设为 **true**；图片会随当前模型请求产生输入 token。B03 视觉模板验证器见 `src/desktop_adapter/verify.py`，支持可选 `critical_region` 检查关键文字区域；proof-bound 程序在 `runtime/programs/notepad-open-file-menu/v2.json`；PreAct 接口说明见 `docs/preact_interface.md`。

0.6.4 新增 `desktop_replay`、W1 窗口上下文和 W2 客户区/窗口区观察：`desktop_click` 在动作前后写 `runtime/runs`（`run_id/run_record`，verification 仍为 unknown），PreAct CLI 同样记录；固定执行器在发送输入前持有 `runtime/locks/desktop-input.lock`，第二个并发请求返回 `DESKTOP_BUSY`，不关闭其他程序、不自动重试。详见 [运行记录](docs/run_ledger.md)。

视觉效率 P0/P1 已加入本地测量和纯函数变化检测：capture/encode/persist、附件准备、locate/verify 计时，以及几何/窗口身份检查、精确 RGB 差异、32×32 变化块和 critical region。默认不改变截图/点击路径，尚未做 live 基线、有界等待或区域图。详见 [视觉效率](docs/vision_efficiency.md)。

W0/W1 窗口上下文已加入只读模块：外框、DWM 可见外框、客户区屏幕矩形、显示器交集、DPI/awareness、几何 revision，已接入 `desktop_windows`、action-ready 观察/绑定和执行器上下文校验。W2 起 `desktop_observe` 支持 `region_space=client|window|explicit`，默认 client；新 PreAct 程序可声明 client/window，旧 v2 保持 legacy 外框+margin。W2 已在运行中的 0.6.4 通过默认 client 空白点击和移动/缩放观察验收。W3 已实现不同画布尺寸的有限补丁定位、最多 8 个尺度、受限搜索中心和 B03 模板区/after 区分离，并已在 Notepad 可见外框上生成 v3 proof：目标 `[17,58]`、菜单区域 B03 前置 0.875736/after 0.999779；重启后新窗口偏移 1px，v3 `desktop_replay` 仍 `completed`，`program_condition_verified=true`、`task_success_verified=false`；窗口缩小到 `820×618`（DPI 仍 144）时，PreAct 按 `clipped_to_current_window` 截取当前可见外框，v3 仍完成，locator 0.996094、B03 after 0.999564。100/125/150% DPI、相似弹窗/双目标负例仍未验收。另已用 `notepad-file-menu-toggle/v1` 做过两步实验（打开/关闭 File 菜单）：`verify_program` 和独立 `preact_replay.py` 都完成两步并通过两步 B03；host bridge 已开放最多 8 步，并已通过 v4 两步 host 实测（2 steps/2 receipts/`program_condition_verified=true`）；仍没有失败回滚：已实测 step1 打开菜单、step2 `TARGET_NOT_FOUND` 后菜单保持打开，只由 cleanup 动作关闭；失败结果现在保留 step1 receipt。前台切换安全已验证：action-ready 观察后切到 Harness，点击被 `FOREGROUND_CHANGED` 拒绝，0 click/0 input。重复窗口歧义已验证：两个 Notepad 同时存在且只按 class 匹配时返回 `WINDOW_AMBIGUOUS`，不激活/观察/输入。精确 title 选择也已验证：v3 只作用于 `test.txt`，未引用另一个窗口；replay 后目标失去前台，cleanup 需单独置前关闭菜单。执行器现在在输入前做最多 5 次、间隔 30ms 的有界帧稳定等待；不匹配仍返回 `FRAME_CHANGED`，不重试动作。当前 Notepad 静止时 16 帧完全一致。详见 [窗口上下文](docs/window_context.md) 和 [有限定位](docs/localization.md)。

## 记忆核心宿主 v1

记忆核心在 `src/assistant_memory`（SQLite，独立于 RAG/程序库存）。宿主薄接入在 `plugins/dsh-desktop-observe/memory.js`：模型只有 `memory_recall`、`memory_propose`、`memory_checkpoint`、`memory_resume`；显式写入/确认/修订/撤销/删除只走人类 `/memory` 命令，不把 CLI 暴露给模型。来源只取真实用户消息，scope 由 session cwd 的 realpath 哈希和固定本机 user 决定；工具结果是 `context_only`、`execution_authority=false`，不拼 system prompt。离线核心 31 项、宿主 10 项检查通过；重启后 `memory-host` 已加载，live recall/propose/history/resume 和两会话命令已检查；`/memory` 结果行在新空会话的可见性仍待修。运行记录与幂等收尾见 [运行记录](docs/run_ledger.md)。详见 [记忆宿主接入](docs/memory_host_integration.md) 和 [记忆契约](docs/memory_contract.md)。

## 当前入口：只读像素观测

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\vision_probe.py monitors
& '.\.venv\Scripts\python.exe' -B scripts\vision_probe.py capture --monitor 1
```

只采集选定显示器当前可见的像素，不点击、切焦点、读取控件树或调用模型。截图、物理像素边界、SHA-256 和事件记录保存在 `results/vision/<run_id>/`。可选 `--region LEFT TOP WIDTH HEIGHT` 指定该显示器内的物理像素区域。必须根据实际 monitors 返回值选择编号。

截图成功不等于 DeepSeek 已识别。截图程序返回 `recognition_status=not_run`、`actionable=false`，模型结果另行记录。本地只读插件已链接到 Harness desktop profile，提供 `desktop_monitors` 和 `desktop_observe`；原生工具注册及截图桥接已离线验证，用户已确认重启后全局插件列表出现 desktop-observe。运行中会话的实际工具调用尚待验证。详见 [Harness 接入说明](plugins/dsh-desktop-observe/README.md) 和 [视觉观测协议](docs/visual_observation.md)。

0.2.0 已实现原生图片附件通道，可沿用当前 Flash，用户已报告重启。2026-10-24 通过 Harness 原生 SDK 隔离入口完成一次真实视觉请求：正确识别计算器、标准模式和 0，等于按钮中心命中，目标框上缘略偏高。实际输入/输出 1005/52 token，费用估算 ¥0.001213，实际账单未知；无点击。详见 [评价记录](results/b01/flash-readonly-20261023/evaluation.json)。只验证一个开发样本，A04/B01 尚未全部完成。全局图片开关保持关闭，已完成的独立试验拒绝继续发送。

## 历史 UIA 原型（暂停推进）

以下命令保留用于复现先前诊断，不再是主线入口。

先打开计算器标准模式，显示 0；不要在测试窗口放私人资料。

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\desktop_probe.py list --application calculator
```

从实际返回的唯一目标窗口取得 hwnd 和 pid，再执行（数字必须换成本次返回值）：

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\desktop_probe.py observe --application calculator --hwnd <HWND> --pid <PID>
```

不确定目标、多窗口或无返回时先核对，不猜句柄。记事本使用 `--application notepad`，只测试新建的虚构文本。此工具不切焦点、不输入、不保存记事本文件；其业务结果保持 unknown，等待独立核对。

如果应用已打开但返回空列表，检查 diagnostics：NO_ALLOWED_PROCESS_METADATA 表示当前执行进程无法取得允许应用的元数据，不等于应用未运行。本次工具嵌套进程出现此限制，需先在 PyCharm 普通终端复核；不用管理员终端或修改安全设置。进程元数据读取优先使用 PATH 中的 pwsh，缺失时使用系统 Windows PowerShell；均为固定只读查询。

结果保存在 `results/desktop/<批次>/`；完整本地事件库在 `runtime/events.sqlite3`。Ctrl+C 可中止前台脚本；任何未完成 run 都不能计为成功，重启不自动重放。历史 UIA 原型没有接入 DSH；当前视觉路线通过原生插件注册工具，没有操作按钮。

桌面依赖安装和候选比较见 [适配记录](docs/desktop_adapter_decision.md)。依赖锁在 `configs/desktop-pywinauto.lock.txt`。临时下载不作为交付；`results/` 是验证证据，`runtime/` 是本地运行数据，均不提交 Git。

---

---

## 冒烟检查（改完代码先跑这个）

```powershell
node scripts/smoke.mjs                  # 自动挑一个正在运行的应用
node scripts/smoke.mjs --process EXCEL  # 指定应用
```

它检查两类**单测抓不到、只有真跑才会炸**的问题：

| 层 | 检查内容 |
|---|---|
| 静态 | `uia-helper.ps1` 必须纯 ASCII（Windows PowerShell 5.1 读无 BOM 的 UTF-8 会解析失败） |
| 静态 | 工具 schema 里不许出现 `required: false`（会让**整个插件加载失败**，会话列表跟着变空） |
| 运行时 | 真的启动 UIA helper、真的遍历窗口、真的按名字找控件并拿到矩形 |
| 运行时 | 名字表缓存命中（第二次应 0ms 级）、应用能力表有记录 |

输出示例：

```
[静态检查]
  ✓ UIA helper 是纯 ASCII — 7733 字符
  ✓ 工具 schema 里没有 required: false — 3 个文件

[运行时检查] 目标：DeepSeek Harness (#67276)
  ✓ UIA helper 能启动并列出控件 — named=513 walk=1041ms 总耗时=1547ms
  ✓ 名字表缓存生效 — 1547ms → 0ms
  ✓ 按名字能精确找到控件并拿到矩形 — Pane · 阅读ASR与陪伴控制手册
  ✓ 应用能力表有记录 — tier A · named 513

结果：6/6 通过
```

**不覆盖**：真实鼠标点击、DSH 的渲染管线、模型请求。这三块目前靠真实任务人工验证（例如让 Orb 执行一次"打开记事本并关闭"）。

辅助脚本 `scripts/find-control.mjs`：按进程名或 `--hwnd` 找一个控件，打印它的类型与矩形，排查坐标问题时可单独用。

---

# 复用与参考的开源项目

本项目不重复造轮子：下面分成两类 —— **复用**（代码在本仓库里真实运行）和 **参考**（只借鉴设计，没有直接运行其代码）。每一行都注明来源、许可，以及**我们改了什么**，便于复核与合规。

## 一、直接复用的组件

| 组件 | 用途 | 版本 / 来源 | 许可 | 我们的改动 |
|---|---|---|---|---|
| **DSH（DeepSeek Harness）** | 宿主运行时：插件系统、会话、工具注册、Web GUI、记忆注入 | 桌面版 0.2.1（`E:\dsh`） | 见官方发行说明 | 不改宿主，只写插件 / 工具 / 技能 |
| **Orb（dsh-orb-cordis）** | 悬浮球与面板、桌面助手外壳、语音、helper 进程；内含 computer-use GUI 工具链 | 上游 0.2.1 → 本仓库 `dsh_orb_full_orig`（Mio 开发版 `0.2.1-mio-dev.32`）<br>https://github.com/mini-yifan/dsh-orb-cordis | MIT | **改动最多的一块**：陪伴模块与状态面板、角色卡与人设桥接、两行浮条、computer-use 增强（UIA 命中信息 / 按名字点击 / 变化判定 / 控件清单与缓存）、多轮 bug 修复（坐标越界、透明窗消失、TDZ 导致 ack 超时等） |
| **dsh-memory-evolve** | 分层记忆（全局/用户/项目/key/每日）、技能管理、待办、临时便签、提示词库 | `third_party/dsh-memory-evolve` 0.1.0 | MIT | 不改代码；按它的模型写记忆、建技能（`launch-windows-apps`、`office-editing`、`im-send-message`） |
| **dsh-watch-together** | 视频陪看：按播放进度给分镜 + 字幕 + 语音 | `third_party/dsh-watch-together` 0.3.3（依赖 `dsh-video-storyboard` 0.7.x）<br>https://github.com/SAOS-3624/dsh-watch-together | Apache-2.0（作者 SAOS-3624） | 插件本体不改；接入本地 ASR 替代默认字幕来源 |
| **dsh-persona-dafeiyu** | 全局人设（角色卡），三档作用域 | 0.8.0（npm 安装）<br>https://github.com/huaizhuanghub/dsh-persona-dafeiyu | MIT | 不改；Orb 的陪伴/指导通过它的 HTTP 桥读取当前人设 |
| **dsh-see-now** | 陪伴的采样管线 `pipeline.js` 与缩放 `scale.js` | `third_party/sources/dsh-see-now-main` 0.0.7<br>https://github.com/SAOS-3624/dsh-see-now | Apache-2.0 | 直接 import（`plugins/dsh-assistant-host/orb-companion.js`） |
| **sherpa-onnx** | 本地语音识别推理（纯 CPU，无需 torch） | pip 包 2.0.1 | Apache-2.0 | 只调用其 API |
| **SenseVoiceSmall（int8）** | ASR 模型权重 | 上游 FunAudioLLM/SenseVoice，经 hf-mirror 下载 | 见上游模型页 | 只加载模型，未改权重 |
| **ffmpeg** | 视频抽帧 / 转码 | 第三方运行时二进制（`third_party/runtimes`，**不入库**） | 见其发行包（LGPL/GPL 视构建） | 调用命令行 |

## 二、参考过、但没有直接运行其代码的项目

这些源码放在 `third_party/sources/`，只用于读思路、比对接口，不参与构建与运行。

| 项目 | 参考了什么 |
|---|---|
| **OmniParser** | "截图 → 可交互元素结构化解析"的整体思路。本项目最终改用 Windows UIA 拿控件，未启用其模型 |
| **RapidOCR** | 无 UIA 应用（如微信）的 OCR 兜底方案，列入后续计划，尚未接入 |
| **Windows-MCP** | Windows 桌面自动化的工具接口设计（动作/参数划分） |
| **mem0 / langmem / LongMemEval / jev-eval** | 记忆系统的分层设计、写入策略与评测方法 |
| **dsh-vision-toolkit / dsh-game-daily / deepagents / dsh-minecraft-*** | DSH 插件的结构、工具封装与打包方式 |
| **ClickableTransparentOverlay** | 透明覆盖层（观察框/高亮）的绘制思路；本项目用 Electron 窗口实现 |

## 三、许可与合规

0. **本项目自身采用 MIT 许可**（见仓库根目录 `LICENSE`）；下面列出的上游组件各自保留其原始许可，不因本项目为 MIT 而改变；
1. 上表"复用"组件的**原始 LICENSE / NOTICE 文件随源码保留在原目录**，未做删除或改写；
2. `third_party/sources/` 与 `third_party/downloads/` 仅作阅读参考，不参与构建，**不随发布物分发**；
3. 模型权重（`tools/asr/models/`）、ffmpeg 二进制（`third_party/runtimes/`）、`node_modules/`、`.venv/` **均不进入本仓库**，使用前请遵循各自许可；
4. 如果本项目的某处实现与上游差异较大（尤其是 `dsh_orb_full_orig` 下的陪伴与 computer-use 部分），以上游仓库的许可条款为准；本仓库只声明"基于其上做了修改"，不额外授权上游代码。
