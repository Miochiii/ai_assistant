# PreAct 重放适配层

2026-10-25。PreAct 不另写鼠标驱动；它通过本适配层调用已入库程序，执行
activate → observe → locate → execute → verify。任何不匹配都停止或重新规划。

## 入口

- Python 类：`scripts/preact_adapter.py::ProgramReplayAdapter`
- CLI：`scripts/preact_replay.py --program-id <id> --version <n>`
- Harness 工具（0.6.4）：`desktop_replay`，入参只有 `program_id`/`version`；不接受坐标、代码或动作数组。最多 8 步的 verified 程序；一次调用内部复用同一适配器，逐步执行/验证，失败停止。需要重启加载新插件代码。
- 运行环境：Medium 的 base Python（从 `.venv/pyvenv.cfg` 的 `base-executable`），
  不能使用带 Low 标签的 `.venv\Scripts\python.exe`。

示例（先授权一次；适配器会自动选择覆盖该窗口的 `replay` 授权）：

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\authorize_task.py --hwnd 788882 --actions activate,observe,click,replay --ttl 3600 --task "打开文件菜单"
& 'C:\Users\Mio\AppData\Local\Python\pythoncore-3.14-64\python.exe' -B scripts\preact_replay.py --program-id notepad-open-file-menu --version 2
```

`--grant-id` 可显式指定授权，`--session` 默认取 `DSH_SESSION_ID`。没有有效授权时适配器在激活前返回 `AUTHORIZATION_REQUIRED`；不会聚焦或截图。0.6.2 的真实 Node 包装无授权冒烟已验证这条拒绝路径：0 输入、0 截图，证据 `results/desktop-replay/no-grant-smoke-20261027.json`。

0.6.3 授权后的单步验收在 locate found [32,47] 后被固定执行器以 `FRAME_CHANGED` 在输入前拒绝：0 click、0 input、0 receipt，未打开菜单。这不是成功重放；后续需要处理观察与执行器之间的像素稳定性（悬停/光标/短暂重绘），不能强制越过执行器检查。证据 `results/desktop-replay/frame-changed-20261028.json`。

W1 起每步输出 `window_context`：外框、DWM 可见外框、客户区屏幕矩形、显示器交集、DPI/awareness 和 geometry revision；观察前后几何变化会丢弃观察。W2 起新程序可在 `visual_basis.region_space` 声明 `client` 或 `window`：`client` 从客户区原点、`window` 从 DWM 可见外框原点开始，不加固定 margin；旧 v2 没有该字段，继续 legacy outer+margin。执行器在输入前重读上下文，geometry revision/身份变化返回 `WINDOW_CONTEXT_CHANGED`。见 [窗口上下文](window_context.md)。

W3 起定位器 `bounded_patch_search_v2` 不再要求 basis/fresh 整图同尺寸，可在 `visual_basis` 中声明 `scale_candidates`（最多 8 个，0.5–3.0）和 `search_center`；B03 可在 `expected` 中声明 `template_region`/`after_region` 及各自 critical region，允许两张整图尺寸不同但裁剪同尺寸。旧 v2 仍走单尺度和旧 region。见 [有限定位](localization.md)。

输出是一个 JSON 结果文件，`status` 为 `completed`、`stopped` 或
`replan_required`。`completed` 仅代表动作执行且预期结果验证通过一个样本。

## 内部回调

`ProgramReplayAdapter` 把四段能力组合起来：

| 阶段 | 行为 |
| --- | --- |
| activate | `window_activate.activate(hwnd)`：只切换前台、回读确认，不输入 |
| observe | `desktop_click_trial.observe`：新 action-ready 观察，带绑定和 RGB 基线 |
| locate | `locate.locate_patch`：在存储目标周围限定区域搜索目标补丁，返回新中心；not_found/ambiguous 停止 |
| execute | `ActionClient` → 固定执行器；不另写鼠标驱动 |
| verify | `verify.compare_template`：动作后图与已存模板比较 |

`inventory.replay` 负责状态机：预条件、目标、执行器拒绝、预期结果任一失败即
返回 `replan_required` 或 `stopped`，不自动重试、不复用旧坐标。

## 程序前提

- 程序必须是 `verification.status=verified` 且执行器版本一致。
- 支持多步：每步在**任何动作前** preflight 自己的窗口、授权、视觉依据和区域；任一步 preflight 失败则不执行前面步骤。执行时每步重新 activate/observe/locate/execute/verify；中途失败停止，不回滚已完成的步骤。
- 每步可以指向不同窗口/区域；授权必须覆盖对应窗口；多步程序不做分支、循环或条件跳转。
- 目标定位用 `target_center` 周围的补丁在限定邻域内搜索；best 与分离的 second 差距不足会返回 ambiguous，不降低阈值硬凑。
- 目标补丁变化、窗口标题/类变化都会停止；搜索半径 64、stride 4，不是全屏 grounding。
- 目标窗口必须可激活；elevated 目标、跨 session、非 `WinSta0\Default` 拒绝。

## 首个样本

`notepad-open-file-menu` v2（v1 是旧的无 proof 记录，加载会拒绝）：

- 观察 400×300，目标 [22,47]；重定位到 [32,47]，桌面 [82,135]（旧目标附近，局部搜索）。
- 固定执行器 1 次点击、3 个事件、输入回读确认。
- B03 对动作后图 `passed`（相似度 0.994179）。
- 证据：`results/b02/single-click-20261025/replay-p0-edge.json`、
  `b03-p0-edge.json`、`p0-edge-menu-closed.png`；任务授权 `ebfc1f5b-...` 1 小时，执行器回执含 grant_id。
- `runtime/programs/notepad-open-file-menu/v2.json` 带内容绑定 HMAC proof；v1 是旧的无 proof 记录，加载会拒绝。proof 绑定程序内容、视觉依据哈希、模板哈希、执行器/验证器版本和运行回执；模板或程序内容改动即失效。
- `runtime/programs/notepad-open-file-menu/v3.json` 是新的可见外框 v3 proof：`region_space=window`、target `[17,58]`、B03 菜单区域 `[0,35,400,350]`；前置 similarity 0.875736 failed、after 0.999779 passed。它仍是单尺度 `[1.0]`；100/125/150% DPI 按用户要求暂不测。旧 v2 保留，便于区分 legacy 行为。
- `runtime/programs/notepad-file-menu-toggle/v1.json` 是两步实验程序（打开/关闭 File 菜单）：`verify_program`、独立 `preact_replay.py` 和 host `desktop_replay` 都完成两步，host B03 0.999779/0.986364。host bridge 最多 8 步；失败 experiment：step1 已执行后 step2 `TARGET_NOT_FOUND`，菜单保持打开，没有自动回滚，只有 cleanup click 关闭；失败结果现在保留 prior receipts。
- 授权文件在 `runtime/authorizations/`；它是本地事故边界，不是签名。没有有效授权时不会 activate/observe/click。

## 限制

- 只支持左键单击；没有输入、按键、滚动。
- 单步/多步都只支持左键单击；没有输入、按键、滚动；多步没有回滚/补偿。
- 多步 preflight 只保证开跑前窗口/授权/依据存在；执行中窗口状态变化仍会停止。
- 视觉定位是有限邻域的目标补丁搜索，不是任意场景的通用 grounding；全屏/大范围重定位未支持。W3 解除了整图同尺寸限制并支持有限尺度和 search_center，但仍是补丁匹配，不是 UI 控件树或语义 grounding。
- 多步每步的 B03 是区域模板验证，不是步骤语义；步骤间因果关系没有额外验证。
- B03 是区域模板验证，不是通用任务语义验证；总相似度通过不等于业务成功。动作前已满足目标会返回 unknown（不做成功判定）。可选 `critical_region` 能抓住关键文字区域的小改动（1px 改动即 failed），但相似弹窗、双目标歧义仍需 OCR/语义验证器或人工核对。
- 目标补丁对 hover/焦点背景敏感：目标菜单项背景从白变蓝时，raw 相似度会掉到 0.47。已加 `edge_iou` 回退（真实 hover 样本 edge 0.9376、second 0.3266、margin 0.6110，定位到 [32,47]）；但仍需多主题/DPI 样本评估边缘误匹配。B03 模板还必须和观察区域原点一致，错位 5px 会产生假阴性。
- 取消：取消文件在移动前、按键前检查；取消后会等待执行器退出，无法确认是否执行时返回 `cancelled_unknown`，不自动重试。强制终止后的按键释放没有保证；当前没有证据表明现场发生过按住不放。
- proof 的 HMAC 密钥在 `runtime/keys/program-proof.key`；它防外部 JSON/工具输入伪造 proof，不防同一用户下的任意本地代码读取密钥。更强的签名/密钥隔离需要后续系统级方案。
- 授权文件是本地可信 JSON，不是签名；防模型/PreAct 越界，不防同用户本地代码改写。授权到期不自动续期；标题变化会使授权失效。
- 截图/附件保留未自动定时执行；`scripts/cleanup_evidence.py` 默认 dry-run，附件只清理 `runtime/attachments.jsonl` 索引内副本。记忆图片默认关闭（`memory_images=false`），具体记忆 schema 待定。
