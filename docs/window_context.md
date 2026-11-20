# 公共窗口上下文 W1（只读）

2026-10-28。按 [窗口上下文设计](log/2026-10-28-window-context-and-general-grounding-design.md) 先完成 W0/W1，不改输入路径、授权或现有程序 proof。

## 已实现

### W0：`FRAME_CHANGED` 诊断

`src/desktop_adapter/single_click.py` 抛出的 `FrameChanged` 现在带局部诊断：

- 图像尺寸
- `changed_pixels` / `changed_ratio`
- `target_changed`
- `changed_bbox`
- `target_box`

执行器把诊断写入回执的 `frame_diagnostics`，仍返回 `FRAME_CHANGED`，不继续输入。既有 `desktop_click_trial` 不因此重试。

### W1：只读窗口上下文

`src/desktop_adapter/window_context.py`：

- 运行在自建 per-monitor DPI awareness 上下文，结束后恢复
- `GetWindowRect` 外框
- DWM `DWMWA_EXTENDED_FRAME_BOUNDS`（失败写错误，不猜）
- `GetClientRect` + `ClientToScreen` 客户区屏幕矩形
- `monitors_intersected`（支持负坐标/多显示器布局）
- `GetDpiForWindow`、窗口/线程 DPI awareness
- 进程创建时间、Windows session（读取失败为 `null` + error code）
- `geometry_revision`：由外框/可见外框/客户区/显示器/DPI 生成
- 窗口身份、标题、前台、owner/root、visible/minimized
- `visibility.status=unknown`，不声称已做遮挡证明
- `capability.action_context_available=false`，W1 明确只读

接入：

- `desktop_windows` 每个窗口带 `window_context`
- `desktop_click_trial.observe` 在截图前后各读一次上下文；身份或几何 revision 变化则丢弃观察
- observation 和 `click-binding.json` 都写 `window_context`
- 执行器读取 observation 时校验二者的窗口身份和 geometry revision；回执只带摘要
- `ProgramReplayAdapter` 记录每步 `window_context`
- `observation_policy` 把客户端矩形/DPI/geometry revision 纳入 context 比较

## Live 证据

2026-10-28 只读 `desktop_windows`：

- Harness 窗口 `hwnd=67848`
  - 外框 `[309,104,1941,1243]`
  - 可见外框 `[319,104,1921,1233]`
  - 客户区 `[320,104,1919,1232]`
  - DPI 144，窗口和采集线程均 per-monitor
  - `geometry_revision=e0e5936c...`
- Windows Explorer `hwnd=721624`
  - 客户区 `[856,298,1199,772]`
  - DPI 144
- UWP CoreWindow `hwnd=132938`
  - 进程创建时间/session 读取失败，明确写 `PROCESS_OPEN_FAILED`、`SESSION_QUERY_FAILED`，没有填 0

证据：[live-context-20261028.json](results/window-context/live-context-20261028.json)。

**没有截图、激活或输入。**

## W2 已接入（客户区/窗口区）

- `desktop_observe` 新增 `region_space=client|window|explicit`
  - hwnd + 无 region：默认 **client**
  - hwnd + region：默认 **explicit**，仍按屏幕物理像素
  - `client` 从当前客户区原点开始
  - `window` 从当前 **DWM 可见外框**原点开始（优先 `visible_frame_rect_screen_px`，缺失才退回 outer rect）
  - 两者都**不固定加 margin**
- `desktop_click_trial.observe` 记录并校验 `region_space`；client 区域必须落在客户区内
- PreAct `visual_basis.region_space=client|window` 使用同一个 `region_from_context` 选择原点；旧 v2 没有该字段，继续走 `outer_margin` legacy 路径
- 执行器在输入前重新读取窗口上下文，身份或 geometry revision 变化返回 `WINDOW_CONTEXT_CHANGED`
- observation/binding 的 `window_context` 校验仍保留

W2 代码已在磁盘，运行中的 0.6.4 已加载并通过 live 验收。旧 v2 程序仍按 legacy 外框+margin 执行，避免破坏旧 proof；新 v3 程序才能声明 client/window。

### W2 live 验收（2026-10-28）

窗口 `hwnd=2097466`：

- 默认 client 观察：capture bounds 等于客户区 `[111,97,1253,827]`，无固定 margin
- 工具路径点击：1 click、3 input events、`input_delivered=true`、屏幕点 `[911,497]`、post delta 0、内容未变
- run ledger：`completed`，verification `unknown`，不是任务成功
- 移动后客户区原点变为 `[178,140]`，尺寸保持；缩放后客户区变为 `948×603`；已用物理像素恢复原客户区 `1253×827`
- 证据：[w2-live-acceptance-20261028.json](results/window-context/w2-live-acceptance-20261028.json)

W2 期间发现并修复：

- 执行器在 `window` 赋值前读取 `window["hwnd"]`，导致 `WINDOW_CONTEXT_UNREADABLE`/异常回执；
- 执行器 JSON 输出改为 `ensure_ascii=True`，避免回执在异常 Unicode 情况下截断；
- `EXECUTOR_BAD_OUTPUT` 现在带 exit/stderr 诊断。

前两次失败工具调用的回执不完整，不能认证为“零输入”；没有对同一观察自动重试。移动/缩放脚本曾在 DPI 上下文外读取外框，已用 WindowContext 客户区和物理像素恢复修正。

W3 的定位器/B03 改动已完成并生成 v3 proof：可见外框 File 菜单 `[17,58]`，B03 菜单区域前置 0.875736/after 0.999779。100/125/150% DPI 仍未验收。见 [有限定位](localization.md)。

## 当前仍未做

- W3：100/125/150% 现场验收；相似错误弹窗/双目标负例；更丰富的窗口锚点
- 遮挡/可见性证明、跨屏拼接、多显示器现场验收
- `FRAME_CHANGED` 的只读重新观察/重定位；当前仍停止
- 窗口选择器的多候选消歧；当前程序仍按精确 window precondition 匹配

## 测试

- 窗口上下文：DPI/几何 revision、负坐标、invalid hwnd、客户区映射、unknown 显式
- `FRAME_CHANGED`：诊断字段
- 观察变化策略：窗口身份/窗口上下文 geometry revision
- 全量 Python **198**、Node **78**
