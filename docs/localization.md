# W3：有限尺度定位与 B03 区域对齐

2026-10-28。W3 核心已落地，并在 Notepad 上生成了新的 v3 proof；100/125/150% DPI 现场验收仍未做。

## 帧稳定性与有界 settle（2026-10-29）

在当前 Notepad 静止状态下连续抓取 16 帧、间隔 120ms：

- 整帧 changed ratio 全部为 0
- 目标框 changed pixels 全部为 0
- 说明这次 `FRAME_CHANGED` 不是持续抖动；此前失败主要来自 outer rect 纳入窗口外桌面

执行器新增输入前有界 settle：

- 最多 5 次，间隔 30ms，总等待最多约 120ms
- 只有 fresh frame 与 observation 匹配后才继续
- 仍不匹配则返回 `FRAME_CHANGED`
- 不重试动作、不重用已消费 observation
- 测试覆盖“两次变化后稳定 → 一次点击”和“持续变化 → 0 点击”

证据：[frame-stability-20261029.json](results/localization/frame-stability-20261029.json)

## 定位器 v2

`src/desktop_adapter/locate.py` 从 `limited_patch_search_v1` 升级为
`bounded_patch_search_v2`。

### 解除整图同尺寸

- 参考补丁仍从 basis 图的 `target_center` 周围提取。
- fresh 图可以是不同画布尺寸或不同原点。
- 不再要求 `basis.shape == fresh.shape`。
- 搜索范围仍由 `search_radius`、`stride` 和候选数上限约束，不扫描无限桌面。

### 有限尺度候选

- `scales` 最多 8 个，每个必须在 `0.5..3.0`；重复值拒绝。
- 每个尺度只生成一个缩放后的参考补丁；使用最近邻缩放，候选位置仍受 `search_radius` 限制。
- `MAX_CANDIDATES = 20000`；超过时返回 `unsupported`，不选最高分。
- 默认 `scales=(1.0,)`；PreAct 的 v3 程序可显式写 `scale_candidates`。
- 若未写且 W2 使用 `region_space=client/window`，适配器会从 basis/fresh 的
  `target_window_dpi` 生成有限候选；DPI 未知时退回 `(1.0,)`，不假装已知比例。

### 搜索中心

- 新增可选 `search_center=[x,y]`，把搜索限制在 fresh 图的一个提示点周围。
- 补丁的 `target_center` 在补丁内的相对偏移会被保留；返回的新中心不是简单取补丁中心。
- 程序 `visual_basis.search_center` 可显式提供提示；旧 v2 没有该字段。
- 窗口客户区/外框锚定由 W2 的 `region_space=client/window` 提供；当前没有额外 UI 控件树锚点。

### 状态

- `found`：最佳候选达到 `min_similarity` 且与分离的第二候选差达到 `min_margin`。
- `ambiguous`：最佳够高但边际不足。
- `not_found`：没有候选达到要求。
- `unsupported`：候选数/参数超出上限。
- 不能把“最高分但不够明确”当成 found。

返回新增：`scale`、`scales`、`search_center`、`locator=bounded_patch_search_v2`。

## B03 区域对齐

`compare_template` 新增：

- `template_region`：模板图上的裁剪区。
- `after_region`：after 图上的裁剪区。
- `template_critical_region` / `after_critical_region`：两张图各自的关键区域。

约束：

- `template_region` 和 `after_region` 裁剪后的宽高必须相同；否则 `unknown`。
- 整张模板/after 可以尺寸不同，只比较对应区域。
- 旧 `region` / `critical_region` 仍按同一坐标用于两张图，旧 v2 行为不变。
- 结果记录 `template_region`、`after_region`、`critical_template_region`、
  `critical_after_region`，便于追溯区域错位。
- 通过只表示“该区域看起来仍匹配”，不表示任务成功。

## 程序字段

新 v3 程序可在步骤中声明（均为通用字段）：

```json
"visual_basis": {
  "observation_id": "<basis>",
  "image_sha256": "<sha256>",
  "capture_bounds": {"left": 0, "top": 0, "width": 400, "height": 300},
  "target_center": [32, 47],
  "region_space": "client",
  "scale_candidates": [1.0, 1.25, 1.5],
  "search_center": [32, 47]
},
"expected": {
  "template": "runtime/templates/<verified>.png",
  "template_region": [0, 0, 400, 300],
  "after_region": [0, 0, 400, 300],
  "critical_region": [0, 0, 120, 40]
}
```

- `search_center` 是 fresh 图上的提示，不是屏幕绝对坐标；执行器仍从观察缓存区推导屏幕点。
- `scale_candidates` 必须有限，不能写无限生成器或全尺度扫描。
- 新字段会进入程序 JSON 和 proof 的内容绑定；**必须重新验证生成新 proof**，不能拿旧 v2 proof。

## PreAct 接入

- `_preflight` 读取 basis 的 `observation.json` 中的 DPI/几何上下文，但不把旧坐标当作现成目标。
- `_locate` 把 `scales` 和 `search_center` 传给定位器；旧 v2 仍传 `(1.0,)`。
- `_observe` 对支持 `region_space` 的 observer 传递 client/window；旧三参数 observer 继续兼容。
- `_verify` 把 `template_region`/`after_region` 及各自 critical region 传给 B03。

## Live v3 proof（2026-10-28）

窗口 `hwnd=2097466`，`region_space=window`，DWM 可见外框 `[110,22,1255,903]`：

- basis：菜单关闭的可见外框观察，`image_sha256=a4ae...`
- target：窗口图像 `[17,58]`（File 菜单）
- template：菜单打开后的 1255×903 图
- B03 区域：`[0,35,400,350]`（不是整图）
- locator：`bounded_patch_search_v2`，`found [17,58]`，similarity 1.0，second 0.666016，margin 0.333984，443 candidates
- B03 前置（菜单关闭）：`failed`，similarity 0.875736
- 点击：1 click、3 input events、`input_delivered=true`，屏幕点 `[127,80]`
- B03 after（菜单打开）：`passed`，similarity 0.999779，changed ratio 0.000221
- v3 proof 已保存到 `runtime/programs/notepad-open-file-menu/v3.json`
- 程序 run `ok=true`、`expected_matched=true`、`fresh_observation=true`；`task_success_verified` 仍为 false

**关键教训**：先用整图做 B03 时，菜单关闭/打开的差异只有 1.5%，整图 similarity 0.984649 高于 0.98，被误判为目标已满足。绑定菜单区域 `[0,35,400,350]` 后前置 similarity 降到 0.875736，才正确阻止“已满足”误判。这说明 B03 区域必须绑定语义/锚点，不能拿大画布稀释关键变化。

同时修正了 `window` 区语义：使用 DWM 可见外框而不是 outer rect，避免捕获窗口左侧不可见边框/桌面色块，导致目标框变化和 `FRAME_CHANGED`。

证据：[w3-v3-proof-20261028.json](results/localization/w3-v3-proof-20261028.json)

### 重启后的 v3 replay

- 新窗口 `hwnd=526822`，可见外框 `[111,23,1255,904]`，比 basis 偏移 1px、高度 +1px
- `desktop_observe region_space=window` 返回 `[111,23,1255,904]`，确认 bridge 使用 DWM 可见外框
- `desktop_replay` v3：`completed`、`program_condition_verified=true`、`task_success_verified=false`
- locator `bounded_patch_search_v2`：`found [17,58]`，similarity 0.998828，second 0.666016，margin 0.332812
- 1 click、3 input events、`input_delivered=true`，屏幕点 `[128,81]`
- B03 after：`passed`，similarity 0.999779，changed ratio 0.000221
- run `d6bd055d-1690-4097-a09c-6598ea1de443`；证据 [v3-live-window-bridge-20261028.json](results/desktop-replay/v3-live-window-bridge-20261028.json)
- 当前仅验证 150% DPI（144）；没有改系统缩放

### 窗口缩小：basis 区域放不下

用户把 Notepad 缩到可见外框 `[111,23,820,618]`，但 DPI 仍是 144；v3 basis 是 `1255×903`。

处理：

- 不再直接 `WINDOW_TOO_SMALL`
- 从同一左上角截取当前完整可见外框 `820×618`
- UI 像素不随窗口 resize 缩放，因此不强行缩放截图
- `clipped_to_current_window=true`

结果：

- locator `found [17,58]`，similarity 0.996094，margin 0.332812
- 1 click、3 input events、`input_delivered=true`，屏幕点 `[128,81]`
- B03 after：`passed`，similarity 0.999564，changed ratio 0.000436
- `desktop_replay` v3 `completed`，`program_condition_verified=true`，`task_success_verified=false`
- 证据：[v3-small-window-20261028.json](results/desktop-replay/v3-small-window-20261028.json)

## 多步实验 W4（2026-10-28）

程序 `runtime/programs/notepad-file-menu-toggle/v1.json`：

- step 1：点击 File → 菜单打开，B03 用菜单区域验证
- step 2：再次点击 File → 菜单关闭，B03 用关闭模板验证
- 两步 basis 分别来自菜单关闭/打开观察；当前窗口 `820×618`，两步都 `clipped_to_current_window=true`
- `verify_program` 完成两步，两个 observation ID、两个 receipt，proof 已保存
- 独立 `preact_replay.py` 重跑：`completed`、2 steps found、2 receipts、run record `passed`
- B03：step1 after `0.999564`、step2 after `0.986443`，均 passed
- 早先一次独立 replay 因 QQ 抢前台被 `INPUT_CHANGED` 安全拒绝，0 click/0 input；用户关闭 QQ 后重跑通过
- **host bridge 已开放最多 8 步**，重启后 v4 host 实测通过：`desktop_replay` 2 步、2 receipts、`program_condition_verified=true`；B03 0.999779/0.986364；证据 [host-multistep-20261029.json](results/desktop-replay/host-multistep-20261029.json)
- **没有回滚**：如果 step2 失败，菜单可能留在打开状态；需要额外关闭动作，不能宣称事务性

证据：[w4-multistep-20261028.json](results/localization/w4-multistep-20261028.json)

### 第二步失败与无回滚（2026-10-29）

draft 两步程序：

- step1 正常打开 File 菜单
- step2 故意使用越界 target `[5000,5000]`

结果：

- step1 已执行，菜单打开，step1 after B03 similarity `1.0`
- step2 `TARGET_NOT_FOUND`
- 最终 `replan_required`，`step_id=2`
- **没有 step2 输入**
- **没有自动回滚**：菜单保持打开，测试脚本另外用 cleanup click 关闭
- 修复了失败路径丢失 prior receipts 的 bug：现在结果带 1 个 step1 receipt/observation ID
- 失败证据：[w4-step2-failure-20261029.json](results/localization/w4-step2-failure-20261029.json)

## 前台切换安全 W5（2026-10-29）

- 对 Notepad 取 action-ready 观察后，把 Harness 切到前台
- 再提交 `desktop_click`：执行器返回 `FOREGROUND_CHANGED`
- `gui_clicks_attempted=0`、`input_events_sent=0`、phase `pre_action`
- 没有重试该观察；随后把 Notepad 恢复前台，0 input
- 证据：[w5-foreground-change-20261029.json](results/localization/w5-foreground-change-20261029.json)

## 两窗口精确 title 选择 W5（2026-10-29）

两个 Notepad：

- `hwnd=198830` `test.txt - 记事本`
- `hwnd=2622240` `2606.07624v1.txt - 记事本`
- 不重叠

使用 v3 精确 title 程序：

- 只选择 `198830`，`desktop_replay` `completed`
- run `98ff932e-fee1-4960-834d-cb3fcc40a8cf`
- 1 step found、1 receipt、`program_condition_verified=true`
- 没有任何 action/observation 路径引用 `2622240`
- **没有保留另一个窗口的 before/after 像素哈希**，因此不声称像素不变；只声称没有被选择/操作

清理时发现目标窗口在 replay 后失去前台（前台回到 `2622240`），cleanup action-ready 观察被拒；随后用单独授权暂时置前 `198830` 关闭菜单，再恢复 `2622240` 前台。菜单最终关闭。

证据：[w5-two-window-exact-selection-20261029.json](results/localization/w5-two-window-exact-selection-20261029.json)

## 重复窗口歧义 W5（2026-10-29）

当前同时存在：

- `hwnd=198830` `test.txt - 记事本`
- `hwnd=2622240` `2606.07624v1.txt - 记事本`

故意使用只按 `class_name=Notepad` 匹配的 draft：

- 结果 `replan_required`
- `reason=WINDOW_AMBIGUOUS`
- `window=null`、`activation=null`、0 receipts
- 没有激活、观察或输入，没有猜哪个窗口

证据：[w5-duplicate-window-20261029.json](results/localization/w5-duplicate-window-20261029.json)

## 当前限制

- v3 proof 仍是单尺度（`scale_candidates=[1.0]`）；多尺度只有离线测试，未在 100/125/150% 缩放现场验收。窗口 resize fallback 已实机通过，但它不等于 DPI 缩放。
- 旧 v2 程序仍走 legacy 外框+margin、单尺度和旧 B03。
- 没有完整 UI 控件树/邻居标签锚点；`search_center` 是调用方提供的有限提示。
- 多目标、相似错误弹窗、布局重排仍需负例现场验证。
- `FRAME_CHANGED` 仍停止；W3 不增加自动重试。
- 没有模型准确率或“通用可靠率”声明。

## 测试

- 不同画布尺寸下平移目标
- 1.5 倍有限尺度补丁
- `search_center` 限制搜索
- scale/candidate 上限
- B03 不同画布同尺寸裁剪通过/失败
- B03 各自 critical region 翻译
- PreAct 将 client region、scales、search_center 和模板/after 区域传给协作组件
- 全量 Python **198**、Node **78**
- 离线证据：[w3-offline-20261028.json](results/localization/w3-offline-20261028.json)
