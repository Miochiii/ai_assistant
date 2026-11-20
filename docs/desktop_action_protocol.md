# 桌面动作协议 v0.5.0

2026-10-25。按用户给定的四条边界实现：固定执行器、统一坐标契约、规划/重放共用执行器、程序库存与重跑验证。

## 1. 固定执行器

- 唯一实现：`src/desktop_adapter/executor.py`，入口 `scripts/desktop_executor.py`。
- 启动者：普通用户权限的 Harness（Medium）。Harness 调 `scripts/run_desktop_executor.mjs`，后者从 `.venv/pyvenv.cfg` 的 `base-executable` 启动 Python；不使用带 Low 完整性标签的 `.venv\Scripts\python.exe`。
- 不改 `.venv`、RAG、系统安全设置，不需要管理员权限。
- 自检 `--self-check` 返回自身完整性、会话、Window Station/Desktop、依赖缺失；自身必须是 Medium，目标不得高于 Medium，否则拒绝。
- 进程固定为“一次请求一个独立进程”，不保留跨动作状态；一次观察最多一次点击，不自动重试。

## 2. 统一坐标契约

请求必须同时携带：

- `observation.observation_id`：已保存的 MSS 观察 ID；
- `observation.image_sha256`：`screen.png` 的哈希；
- `observation.image_size`：定位器实际看到的图片尺寸；
- `observation.desktop_origin`：`capture_bounds.left/top` 的物理桌面原点；
- `target.center`：目标在**图片像素**中的位置。

执行器自行完成 `screen_point` 映射，调用方不能提供屏幕坐标。当前版本拒绝 `image.resized=true`，只接受未缩放的原图；`capture_bounds.width/height` 必须与 `image_size` 一致。

示例：

```json
{
  "schema_version": 1,
  "request_id": "7f1c...",
  "observation": {
    "observation_id": "497e59c0-bfb5-4e41-9e68-54e9f400c21f",
    "manifest": "results/vision/93acb68b-51a2-4468-8417-7a1ef9cb909f/observation.json",
    "image_sha256": "310071a96b52ac8a6b7470956146075bf7d69a729303f19fcbd8825cd9df3ecb",
    "image_size": {"width": 800, "height": 600},
    "desktop_origin": {"left": 355, "top": 63}
  },
  "target": {"label": "文件(F)", "center": [34, 51]},
  "action": {"type": "click", "button": "left"},
  "expected": {"description": "File menu is open"}
}
```

## 3. 执行器检查顺序

1. 请求结构、observation 路径必须位于 `results/vision/`；
2. 自身完整性必须是 Medium；依赖（mss/numpy/pywin32）齐全；
3. manifest、`click-binding.json`、`source.rgb` 的 ID/哈希/尺寸/原点一致；
4. 观察不超过 180 秒；
5. 目标进程完整性可读且不高于 Medium；同 session；`WinSta0\Default`；
6. 窗口身份/几何、前台、最近输入时间未变，目标未被遮挡；
7. 当前帧与观察基线逐像素比较，目标附近必须完全一致；
8. 写入一次性 `click.once`，移动指针并回读；回读失败不发送鼠标按键；
9. 发送按下/抬起，等待后读取光标、前台、输入时间，再保存动作后截图；
10. 返回 `input_delivered` 或 `input_unconfirmed`，`task_success_verified` 永远为 false，任务成功需独立验证。

拒绝时返回稳定 `error_code`（如 `EXECUTOR_INTEGRITY_NOT_MEDIUM`、`TARGET_INTEGRITY_TOO_HIGH`、`FRAME_CHANGED`、`OBSERVATION_ALREADY_CONSUMED`），不重试。

目标窗口必须已经在前台；执行器本身不调用 `SetForegroundWindow`。目标不在前台时先调用 `desktop_activate`：它只切换前台并回读确认，不做鼠标键盘输入，拒绝 elevated 目标；之后仍按本节的窗口/遮挡/输入检查执行。前台、遮挡或输入状态变化直接拒绝，不重试。

## 4. 规划与重放共用接口

- Python：`src/desktop_adapter/action_client.py` 的 `ActionClient`，必须在 Medium 进程内运行；Low 客户端在启动执行器前返回 `CLIENT_INTEGRITY_NOT_MEDIUM`。
- Node/Harness：`scripts/run_desktop_executor.mjs` 导出 `buildRequest`、`click`、`runExecutor`、`selfCheck`、`runWindowActivate`；`click` 只接受图片像素坐标。
- Harness 工具（插件 0.5.1）：`desktop_windows` →（目标不在前台时）`desktop_activate` → `desktop_observe`（带 `hwnd`，生成 action-ready 观察）→ `desktop_click`。`desktop_activate` 只切换前台；`desktop_click` 只把附件像素坐标转换成请求，不直接发送输入；执行器完成动作后返回新观察、`post_action_delta`，图片通道开启时另附动作后截图。
- PreAct：`scripts/preact_adapter.py::ProgramReplayAdapter` + `scripts/preact_replay.py` 已把 activate/observe/locate/execute/verify 封装成稳定适配层；PreAct 只需加载程序并调用适配层，不允许另写鼠标驱动或绕过检查。适配层运行在 Medium 的 base Python，内部仍走 `ActionClient`/固定执行器和 `inventory.replay` 状态机。

## 5. 程序库存

- 模块：`src/desktop_adapter/inventory.py`；存储：`runtime/programs/<program_id>/v<version>.json`。
- 每个步骤保存：`target_label`、`visual_basis`（观察 ID、图片哈希、capture_bounds、目标像素点）、`preconditions`、`action`（只有点击意图，**禁止**存坐标）、`expected`；程序级保存 `executor_version`。
- `save_program` 只接受：`verification.status=verified`、所有 run 均 `ok/expected_matched/fresh_observation`、每个步骤使用**不同于原始观察**的新 observation ID、执行器版本一致，并且存在内容绑定 HMAC proof。外部 `parse_program` 默认只能创建草稿；verifier 组件（`verify_program`）负责晋升 verified 并生成 proof。
- proof 绑定程序内容、视觉依据哈希、模板哈希、执行器/验证器版本和 run 回执哈希；`load_program`/`save_program` 校验，模板或程序内容改动即失效。密钥在 `runtime/keys/program-proof.key`，防外部 JSON/工具输入伪造，不防同一用户任意本地代码读取。
- `replay` 每次重新观察、重新定位；`STATE_MISMATCH`/`TARGET_NOT_FOUND`/`OBSERVATION_NOT_FRESH` 返回 `replan_required`，执行器拒绝返回 `stopped`，不自动重试、不把旧坐标搬过去。验证结论只接受 `status == "passed"`；failed/unknown/布尔/格式错误均停止。
- 先 `verify_program` 成功并生成 proof，再 `save_program`；程序版本已存在时拒绝覆盖。首个样本已从无 proof 的 v1 迁移为 `runtime/programs/notepad-open-file-menu/v2.json`；v1 现在会被 `load_program` 拒绝。
- proof-bound v2 已真实重放：激活 → 新观察 → 目标补丁匹配 → 固定执行器点击 → B03（含 before-image 因果检查）`passed` 0.994782；`replay` 返回 `completed`，`expected_matched=true`。证据 `results/b02/single-click-20261025/replay-notepad-open-file-menu-v2.json`、`b03-preact-v2.json`、`preact-v2-security-summary.json`。

## 5.2 取消与回执真实性

- Node 启动器接收 AbortSignal，向执行器写取消文件；Python 执行器在输入前、按键前检查。取消后启动器等待子进程退出；无法确认是否执行时返回 `cancelled_unknown`，不自动重试。
- 动作后异常不再把 `gui_clicks_attempted`/`input_events_sent` 清零；保留执行阶段（`phase`/`stage`）并返回 `unknown_after_input`。没有证据时不能声称“没有输入”。
- 超时会写取消文件并等待退出；超时结果按 unknown 处理。强制终止后的按键释放仍无保证。

## 5.1 视觉模板验证器（B03 最小版）

- `src/desktop_adapter/verify.py` 用标准库解码 8-bit PNG，按区域比较已确认模板和动作后截图；返回 `passed/failed/unknown`、相似度、变化比例、区域和哈希。
- 现场结果：菜单打开的已验证模板对现场动作后截图 `passed`，相似度 `0.994782`；对动作前闭合菜单 `failed`，相似度 `0.823038`，说明检查能区分两种状态。证据 `results/b02/single-click-20261025/b03-verification.json` 与 `b03-negative-before-menu.json`。
- 通用关键区域：可选 `critical_region`（绝对图像坐标）+ `critical_tolerance` + `max_critical_changed`。关键文字区域的小改动即使总相似度 ≥0.98 也 failed；区域外改动不误报；critical 越界返回 unknown。现场菜单 critical 0.0、passed 0.994526，证据 `b03-critical-region.json`。
- 这是“区域仍像已验证模板”的视觉状态检查，不是通用语义验证器；模板必须来自已验证运行，并随程序库存保存。`critical_region` 是通用视觉参数，不是键盘/应用专用逻辑。

## 5.3 任务授权与保留

- 授权：`src/desktop_adapter/authorization.py`；用户用 `scripts/authorize_task.py --hwnd ... --actions ... --ttl ...` 创建。授权绑定窗口身份、动作集合、Harness session、Windows session 和有效期；`desktop_activate`/带 hwnd 的 `desktop_observe`/`desktop_click`/PreAct 适配器自动选择，固定执行器读请求 grant_id 再复核。没有授权返回 `AUTHORIZATION_REQUIRED`，越界窗口/动作拒绝。
- 授权文件是本地事故边界，不是签名；防模型/PreAct 越界，不防同用户任意本地代码改写授权文件。
- 保留：`configs/retention.json`、`src/desktop_adapter/retention.py`、`scripts/cleanup_evidence.py`。普通 vision 24h、RGB 1h；程序视觉依据和 `runtime/templates` 长期保留；Harness 附件 24h 且只删 `runtime/attachments.jsonl` 索引内副本。默认 dry-run。
- 2026-10-25 真实授权样本：Notepad `ebfc1f5b-...`，proof-bound v2 重放在授权下完成，执行器回执含 grant_id，B03 0.994782；证据 `results/b02/single-click-20261025/replay-grant-v2.json`、`b03-grant-v2.json`。

## 5.4 限定区域重定位

- `src/desktop_adapter/locate.py` 在存储目标周围半径 64、stride 4 搜索目标补丁；raw 路径 best 必须 ≥0.98，且与分离的 second 差距 ≥0.005；raw 不满足时用 `edge_iou` 回退（edge 阈值 40、最低 0.7、仍需分离 second/margin），否则 `not_found`/`ambiguous` 停止。
- 返回新 `new_center`，不再固定使用旧 [x,y]；适配器把 `location` 证据写入重放结果。
- 2026-10-25 真实样本：v2 授权重放从 [22,47] 重定位到 [32,47]（0.9867，second 0.6269，margin 0.3598），B03 0.994179；证据 `results/b02/single-click-20261025/replay-relocate-v2.json`、`b03-relocate-v2.json`。
- 不是全屏 grounding；搜索半径外的布局变化、双目标歧义会停止。
- 2026-10-25 现场复核：重启后 live grant 链路通过，B03 对齐后 `passed` 0.994526；先用 `[55,83]` 观察、模板原点 `[60,88]` 时 B03 假阴性 0.7557。模板必须绑定观察原点。
- 2026-10-25 PreAct v2 现场先 `TARGET_NOT_FOUND`（hover 后 raw 0.474），加 `edge_iou` 回退后完成：edge 0.9376、second 0.3266、margin 0.6110，定位 [32,47]，B03 0.994526；证据 `replay-p0-edge.json`、`b03-p0-edge.json`。回退不是降低 raw 阈值，搜索仍有半径 64 限制。
- 多步程序已支持：每步 preflight 自己的窗口/授权/依据/区域，全部通过后才开始动作；每步重新 observe/locate/verify，中途失败停止，不回滚已完成步骤。没有分支/循环/条件跳转。
- 2026-10-25 多步单元测试覆盖两步成功和第二步 preflight 失败（失败前 0 次动作）；没有真实多步桌面样本。

## 6. 当前限制

- 只支持左键单击；输入、按键、滚动尚未实现。
- 只接受未缩放观察；缩放附件需另立契约。
- B03 是区域模板验证，不是通用任务语义验证；程序库存的 `expected` 仍由调用方 verifier 判定。B03 已接入 `scripts/preact_adapter.py` 的 verify 回调并用于真实重放；重放的目标定位是“当前图与视觉依据的目标补丁匹配”，不是通用检测器。关键文字可用 `critical_region` 覆盖，但相似弹窗/双目标歧义仍不是语义保证。
- 插件 0.5.1 的五个工具已重启加载并完成现场授权链路：`desktop_windows` → `desktop_activate`（`foreground_confirmed`，0 输入）→ `desktop_observe([60,88,400,300])` → `desktop_click`；回执含 grant_id，1 次点击/3 事件，`phase=after_input`，B03 0.994526。无授权窗口被拒绝。证据 `results/b02/single-click-20261025/p0-restart-live-summary.json`、`b03-live-grant-p0-phase.json`。
- `configs/desktop-observe.json` 的 `image_attachment_enabled` 已按用户要求长期设为 true，不再逐次授权；图片会随当前模型请求产生输入 token。
- 固定执行器的脚本链路也已在 2026-10-25 实测一次真实点击（目标 [22,47]→[369,113]，回执 `results/b02/single-click-20261025/action-chain-live.json`）。程序重放与现场模型链路是两条独立证据，均只覆盖单样本。
- PreAct 适配层已真实重放：单步 v2 多次成功；多步由单元测试覆盖。最新 P0 在授权下完成，hover 场景由 `edge_iou` 回退定位到 [32,47]，B03 0.994526；证据 `replay-p0-edge.json`、`b03-p0-edge.json`。适配层支持多步 preflight，但没有真实多步桌面样本、没有回滚。
- 任务授权与保留策略已实现（见 5.3），限定区域重定位、hover 边缘回退、多步 preflight 和 critical region 已实现（见 5.4/5.1）；但授权文件是本地可信文件而非签名；保留清理默认 dry-run，Harness 附件只覆盖索引内副本。未实现：相似弹窗/双目标语义、全屏/大范围重定位、多步回滚/分支、强制终止后的按键释放保证；记忆 schema（等 Astra）。
- proof 密钥是本地 HMAC 密钥，防外部 JSON/工具输入伪造，不防同一用户下任意本地代码读取；更强隔离需要系统级密钥/签名方案。
