# 只读视觉观测 v0.1

2026-10-23 附件扩展：Harness 插件 0.2.0 已提供可选图片块，默认关闭，详见 `../plugins/dsh-desktop-observe/README.md`。下方旧现场记录描述首次截图和 0.1.0 接入；原截图协议不变，模型坐标另以实际附件像素尺寸为准。离线检查通过不代表 Flash 已完成识别。

2026-10-23：按用户决定，桌面识别改为视觉优先。截图和坐标接口不包含计算器/记事本进程名称、控件表或固定按钮坐标；测试目标由用户指令和实际截图确定。

## 当前实现

- `src/desktop_adapter/vision.py`：MSS 10.2.0 采集可见像素、PNG 输出、物理坐标边界及离线点位映射。
- `scripts/vision_probe.py`：列显示器、单张截图；截图工作进程 15 秒上限；复用 A03 EventStore。
- `configs/desktop-vision.lock.txt`：版本与 PyPI wheel SHA-256 固定。MSS 是 Windows-MCP 支持的截图后端之一，没有运行时依赖；未安装 Windows-MCP 完整依赖、Orb 或 Vision Toolkit 插件。
- 参考 Orb 的物理像素与动作后观察设计，但本轮没有移植输入动作。未复制第三方源码。

输出目录：`results/vision/<run_id>/`，成功时包含 `screen.png`、`observation.json`、`events.jsonl`。失败写入 `error.json` 并保留失败事件；PNG/清单是正式现场证据，不属于临时文件。

## 坐标与证据约定

1. 原始截图不缩放；`capture_bounds` 的 left/top 是 Windows 虚拟桌面物理像素原点，允许负值。裁剪区域必须完全位于选定显示器内，最多 3200 万像素。
2. 若后续模型收到缩放图，必须提供模型实际看到的 width/height。`screen_point` 用截图边界和图像尺寸映射到物理桌面坐标，不使用猜测的 DPI 倍率。
3. 坐标右边界/下边界不包含在有效区域；NaN、无穷、越界坐标直接拒绝，不静默夹到屏幕边缘。
4. 本轮所有快照 `actionable=false`。映射函数只计算，不点击。后续输入必须另行完成新鲜度、目标范围、人工抢占、失效状态及动作后验证。
5. 当前程序不调用 OCR/VLM，`recognition_status=not_run`。Codex 看图检查是开发检查，不冒充 DeepSeek/Harness 的自动识别结果。
6. 像素采集保留遮挡关系。被其他窗口遮住的内容不可当作可点击目标。无控件树、后台窗口重建或应用专用识别分支。

## 本机检查

首张截图 run：`200539f5-a602-4abb-a45f-f32522bd10b5`，显示器 2560×1440，采集及 PNG 写入约 183.11ms（单样本，不是统计性能）。Codex 看图确认标准计算器显示 0；现场同时存在 python.exe 错误弹窗，因此此图不是干净桌面验收样本。

受限工具进程导入 ctypes 时失败，并出现 python.exe 应用程序错误弹窗；普通本机执行通过。原因尚未完全定位，不据此认为用户 Python 环境损坏。后续本机采集使用普通进程，不修改系统设置。

35 项项目测试通过，其中 6 项新增坐标边界测试覆盖缩放、负原点、裁剪偏移与非法坐标。`pip check` 通过。测试结果：`results/a04/tests-vision-2026-10-23.txt`。多屏、真实不同 DPI、窗口移动后的重新定位尚未实测。

## 下一步

干净截图与 Harness 接入层的离线检查已完成，用户已确认重启后全局插件列表出现 desktop-observe。下一步接入视觉识别，验证实际工具调用；准备见 `docs/vision_trial_plan.md`。正式模型小试前固定图像发送内容、模型、调用次数、重试与输出上限，并按用户要求确认具体 API 预算。结果验证器通过之前不开放输入动作。

## 2026-10-23 · 干净截图与 Harness 接入

- 用户关闭弹窗后，完整桌面截图 `104ca6a0-06e2-4ce3-bf52-3822c55ffbd9` 成功：2560×1440，181.78ms（单样本）。开发看图检查确认计算器标准模式、显示 0，无遮挡弹窗。
- Node 接入层实际调用 Python，返回裁剪截图 `c0c3534f-312b-4cd7-b9f3-4597eadad655`：边界 `[190,235,1245,1093]`，PNG 1245×1093；SHA-256 `5c444a2ace914f93858d3068dd8b820bf37e36620c6da887a281d3ba1f1efeda`。区域来自现场截图，只用于该次检查，未写成软件专用坐标。
- 本地插件 `plugins/dsh-desktop-observe` 已以 link 安装到 desktop profile。只注册 `desktop_monitors`、`desktop_observe`，仅允许本项目工作目录的会话调用；返回本地图片路径及校验信息，不自动把图片发给模型。
- 使用已安装 DSH 0.2.1-rc.2 的真实 ToolRuntime 验证注册和卸载，提示词服务使用空桩，没有启动代理或模型。5 项 Node 测试通过；截图桥接与注册契约报告分别见 `results/a04/dsh-observe-smoke.json`、`dsh-observe-contract.json`。
- 用户已重启 Harness，并确认「设置 → 内置插件 → 全局插件」出现 desktop-observe。安装配置仍包含插件，日志目录无本次新增崩溃文件；Computer Use 读取窗口时应用访问授权超时，实际工具调用仍未验证。CLI 明确拒绝对 Electron 独占管理的 desktop profile 使用 `--dump-config`，未将此限制误判为插件错误。
- 这些结果不代表 DeepSeek 已识别图像，B01 仍未完成。RAG 链接和原有配置补丁保持不变；未安装 CUDA、调用付费 API 或执行鼠标键盘输入。
