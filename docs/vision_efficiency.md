# 视觉效率 P0/P1：测量与变化检测

2026-10-27。依据 [GPT 视觉效率方案](log/2026-10-27-visual-efficiency-plan-for-deepseek.md)。本轮只做 **P0 测量 + P1 shadow 纯函数**，不改变真实截图/点击行为。

## 已实现

### P0 计时

- `src/desktop_adapter/vision.py`：`capture()` 增加
  - `timings.capture_ms`
  - `timings.encode_ms`
  - `timings.persist_ms`
  - `timings.total_ms`
- `scripts/desktop_click_trial.py`：action-ready 观察增加
  - `identity_ms`
  - `capture/encode/persist`
  - `manifest_write_ms`
  - `binding_write_ms`
  - `observe_total_ms`
  - sidecar `observation-timing.json`
- `plugins/dsh-desktop-observe/image-delivery.js`：附件准备增加
  - `read_ms / hash_ms / save_ms / receipt_ms / total_ms`
  - 仍注明 `plugin_model_calls=0`，不把它冒充任务模型调用数
- `scripts/preact_adapter.py`：每步
  - `observe` 计时
  - `locate_ms`
  - `verify_ms`
- `desktop_click` 输出 `observation_timings`；图片附件输出 `attachment_timings`。

### P1 shadow

- `src/desktop_adapter/observation_policy.py`
  - `geometry_of/check_context`：窗口原点、尺寸、monitor、resize、坐标空间变化 → `context_changed`
  - `analyze_rgb`：
    - 同尺寸 RGB 精确比较
    - signed-safe 像素循环
    - 32×32 变化块聚合
    - `omitted_regions` / `omitted_changed_pixels`
    - critical region 独立计数
    - 等亮度不同颜色能检出
  - `ShadowTracker`：有状态 shadow，只返回 baseline/unchanged/changed/context_changed
  - 不发送输入、不调用模型、不授权
- `scripts/compare_observations.py`：比较两个已存观察的 RGB
- `scripts/benchmark_capture.py`：在指定物理区域测 capture/encode/persist，临时证据用完删除
- `configs/observation_policy.json`：默认 `off`，保留 `shadow/on` 开关，尚未接入执行路径

## 本轮 live smoke（2026-10-27，记事本）

- 窗口 `hwnd=985238`，区域 `(200,250,400,300)`，仅 observe 授权，测完已撤销。
- 直接 capture 5 次：capture 中位 **7.59 ms**、encode **1.22 ms**、persist **0.95 ms**、total **9.76 ms**；首次 cold outlier 72.19 ms。
- action-ready 观察 2 次：单次内部 capture 约 **10–12 ms**，完整 Python 观察 **68.48 / 69.35 ms**；窗口身份 **0.05 ms**，manifest/binding 写入均小于 1 ms。
- 两帧同区域 RGB 完全相同，变化检测返回 **unchanged**（只代表采样相同，不是任务成功）。
- 未请求图片附件，未调用模型，未发送输入；`model_calls=null`，不能据此得出端到端延迟结论。
- 证据：[notepad-live-p0-20261027.json](results/vision-efficiency/notepad-live-p0-20261027.json)、[capture-notepad-20261027.json](results/vision-efficiency/capture-notepad-20261027.json)、[notepad-change-20261027.json](results/vision-efficiency/notepad-change-20261027.json)。

初步判断：本地截图/编码/落盘不是主要瓶颈；这个样本里 **子进程/桥接启动开销约 57 ms**，比截图本身大。模型请求和附件投递延迟仍未测。

### 一次带图样本（2026-10-27）

同一记事本区域，`include_image=true`：

- 400×300，PNG **4,622 bytes**
- 本地 capture **8.05 ms**，完整 observe **69.89 ms**
- 工具调用到结果 **297 ms**；扣掉本地 observe 后约 **227 ms** 为 Node 桥接/附件准备（这一版运行中插件还没有精确的 `attachment_timings`，所以是推断）
- 工具结果到下一 assistant message **6,008 ms**；包含模型处理/推理，不是纯推理或纯网络延迟
- 只发送了 1 张图，未发送输入；observe-only 授权已撤销
- 证据：[notepad-image-latency-20261027.json](results/vision-efficiency/notepad-image-latency-20261027.json)

这个样本里，**模型处理段远大于本地截图**。接下来应先减少模型往返/图片轮次，而不是继续压 PNG。

## 未实现

- 没有 live 截图基线；需要用户指定安全窗口/区域后运行。
- 没有有界等待、稳定帧判定、自动路由或真实点击行为改变。
- 没有区域裁剪、缩放、OCR、第二视觉模型、JPEG/低质量压缩。
- 没有 Harness 模型请求数的真实观测；报告中使用 `null / not_observable`，不拿 `plugin_model_calls` 代替。
- 没有 P2 的 Harness 重放工具桥；PreAct CLI 仍是现有入口。
- 没有 P3 的 `analysis_view` 派生图坐标契约。

## 测试

```powershell
& '.\.venv\Scripts\python.exe' -B -m unittest tests.test_observation_policy -v
```

10 项：相同帧、tiny 颜色变化、等亮度颜色、几何变化、窗口身份变化、critical 区域、unfinished 块、非法输入、ShadowTracker（baseline→unchanged→changed→context_changed），以及 capture 计时字段的假 MSS 测试。

## 使用

先测只读区域：

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\benchmark_capture.py --region 100,100,400,300 --runs 5
```

再比较两个已存 action-ready 观察：

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\compare_observations.py `
  --previous runtime\...\observation.json --current runtime\...\observation.json `
  --previous-rgb runtime\...\source.rgb --current-rgb runtime\...\source.rgb
```

`unchanged` 只代表两次采样像素相同，不是任务成功；`changed` 只代表候选区域，不是点击目标。
