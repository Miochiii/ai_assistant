# 给 DeepSeek：通用窗口上下文、目标定位与 PreAct 分层设计

日期：2026-10-28（UTC+08:00）  
项目：`E:\file\agent\ai assistant`  
文档状态：技术设计，待实现和验收。本轮只新增本文，不修改代码、配置、授权或程序 proof。

## 1. 架构决定

用户目标是通用桌面智能助手。窗口识别、坐标处理、当前目标定位、输入执行与验证属于公共底座；PreAct 保存经过验证的任务流程，调用公共底座完成重放。

PreAct 不仅能保存用户特化任务，也能保存通用任务。分界是“能力与流程”，不能变成“普通模型操作有一套坐标逻辑，PreAct 又有另一套”。

| 公共底座负责 | PreAct/程序库负责 |
| --- | --- |
| 当前可用窗口、候选消歧、运行期绑定 | 任务目标、步骤、适用条件 |
| 窗口外框、客户区、DPI、显示器、前台与遮挡证据 | 各步骤面向的窗口角色与选择条件 |
| 当前截图中的目标定位与坐标转换 | 目标语义、参考补丁、锚点与搜索提示 |
| 输入执行、三态验证、取消与互斥 | 顺序调用、遇失败停止、记录已完成步骤 |
| 观察与输入的证据契约 | 内容绑定 proof、经过验证的程序版本 |

通用层可以使用 Windows 标准窗口 API 获得几何和身份信息，界面内容仍以通用视觉为主。这不是为每个软件写专用脚本，也不要求回到按计算器进程名/UIA 控件硬编码的路线。

优先级调整：**先公共窗口上下文与坐标契约，再稳定观察与尺度定位，最后继续视觉请求效率优化。** 已有计时和变化分析继续保留，但不以性能为理由跳过定位可靠性。

## 2. 本次核对到的代码现状

读取日期为 2026-10-28，磁盘插件清单为 0.6.3；未验证当前 Harness 内实际加载版本。以下是局部源码核对，不是完整安全审计或实机验收。

| 入口 | 现状与约束 |
| --- | --- |
| [single_click.py](<E:/file/agent/ai assistant/src/desktop_adapter/single_click.py>) | `identity()` 返回 hwnd/pid/class_name/title/rect；已有线程级 per-monitor DPI awareness 上下文。目标检查比较身份/几何、前台、输入和命中窗口 |
| [desktop_click_trial.py](<E:/file/agent/ai assistant/scripts/desktop_click_trial.py>) | action-ready 观察要求前台、区域落在窗口外框内且完全属于一个显示器；截图前后检查部分状态 |
| [preact_adapter.py](<E:/file/agent/ai assistant/scripts/preact_adapter.py>) | preflight 根据程序窗口条件逐字段匹配；观察区域使用外框加固定 margin，尺寸参考旧 capture_bounds |
| [locate.py](<E:/file/agent/ai assistant/src/desktop_adapter/locate.py>) | 默认 64×40 补丁、64 像素搜索半径，要求新旧图片尺寸相同；有 raw/edge 路径和歧义拒绝 |
| [executor.py](<E:/file/agent/ai assistant/src/desktop_adapter/executor.py>) | 固定执行器复核窗口、输入、像素；`FRAME_CHANGED` 表示基线与执行前画面不符，不能仅凭代码归因于光标或动画 |
| [authorization.py](<E:/file/agent/ai assistant/src/desktop_adapter/authorization.py>) | grant schema 1 的窗口键包含 hwnd/pid/class_name/title；更改身份策略会影响授权，不能直接删掉标题字段 |
| [observation_policy.py](<E:/file/agent/ai assistant/src/desktop_adapter/observation_policy.py>) | 已有纯函数变化分析与 geometry 比较；要扩展窗口/DPI语义，不另写平行策略 |
| [replay.js](<E:/file/agent/ai assistant/plugins/dsh-desktop-observe/replay.js>) | 已有只接收程序 ID/版本的桥接，并明确拒绝多步程序；不要按昨日方案再建一个工具 |

现行约束继续有效：[动作协议](<E:/file/agent/ai assistant/docs/desktop_action_protocol.md>)、[PreAct 接口](<E:/file/agent/ai assistant/docs/preact_interface.md>)。

旧方案与本文的关系：[视觉效率方案](<E:/file/agent/ai assistant/log/2026-10-27-visual-efficiency-plan-for-deepseek.md>) 是性能实施建议；本文补充它之前所需的窗口/定位契约，并承接已落地的代码，不把“计划新增”重复当成未实现。

## 3. 窗口选择、运行期身份、授权必须分开

### 3.1 WindowSelector：寻找候选，不授予操作权限

程序保存的是窗口角色和选择线索，例如应用标识、窗口类、是否为所属对话框、标题匹配策略，以及当前任务需要的文档线索。不持久保存跨会话 HWND/PID 作为永久身份。

选择流程：用户明确指定的当前窗口优先 → 标准元数据筛选 → 多候选时用任务/文档线索和必要视觉消歧。结果为 `resolved / ambiguous / not_found / unavailable`。

标题是线索而非唯一身份；“*测试.txt - 记事本”变化为“测试.txt - 记事本”可能仍是同一个窗口，但不能据此默认它还是同一个任务文档。多个候选不按列表第一项、最大相似分或前台窗口直接选中。置信度也不等于授权。

标题内容、窗口内文字和视觉结果均是数据，不能作为修改权限或执行代码的指令。只读取任务所需信息，不收集其他窗口正文。

### 3.2 WindowBinding：绑定本次运行的具体实例

建议运行期绑定包含：Windows session、HWND、PID、进程创建时间、窗口类、绑定生成号；可记录拥有者/根窗口关系与应用标识来源。

需要明确：HWND 可能复用；PID 加进程创建时间能区分进程重启，不能证明同进程内 HWND 从未销毁重建。可用生命周期事件使绑定失效，但事件丢失/重启后不猜测连续性；无法证明时重新选择并检查授权。不要发明 Windows 并未提供的“绝对永久窗口 ID”。

身份读取失败、进程信息不可读或系统调用失败，要返回 unavailable/unknown；不能把缺失值填成 0 后参与唯一匹配。

### 3.3 Grant：约束动作、目标、会话与有效期

候选选择策略与授权判断不得共用一个“相似就通过”的函数。

- v1 grant 保持原有行为，标题变化导致拒绝时不能悄悄绕过。
- 若引入新 grant schema，明确区分“允许本窗口内任务”与“允许指定文档任务”。文档级授权仍需要文档上下文约束；不能以窗口没变为由操作另一个标签页/文档。
- 不把旧 grant 自动迁移成更宽松的新 grant。新策略按现有用户授权范围创建或重新绑定；只有范围不明确或实际扩大时才询问用户。
- 同一窗口移动/大小改变通常可在既有目标授权内重新观察，但旧观察与旧目标必须失效。
- 新进程、新窗口实例、另一个同名窗口不自动继承授权。
- owned popup 不因为同进程或 owner 相同就自动获准操作。若支持派生弹窗，授权模型需预先定义任务相关弹窗的边界并在运行时绑定；首版不能确认则停止。

## 4. WindowContext：统一几何与状态快照

建议新增 `src/desktop_adapter/window_context.py`，或在等价公共模块中实现。以下字段为设计建议，**不代表现有协议已经支持**。

```text
WindowContext
  schema_version
  context_id, observed_at
  identity
    hwnd, pid, process_started_at, class_name, binding_generation
    windows_session, application_identity, identity_source
  presentation
    title, foreground_hwnd, visible, minimized
    owner_hwnd, root_hwnd
  geometry
    window_rect_screen_px
    visible_frame_rect_screen_px       # 可选，读取失败有明确状态
    client_rect_screen_px
    monitors_intersected              # 显示器布局，不只一个主显示器编号
    target_window_dpi, target_dpi_awareness
    capture_thread_dpi_awareness
    geometry_revision
  visibility
    status: checked_at_target | unknown | blocked
    checked_point, checked_at, evidence
  capability
    read_only_available, action_context_available, reason_codes
```

`geometry_revision` 是宿主比较本次几何字段后生成的版本/摘要，不是系统自带字段。窗口位置、客户区、DPI、显示器布局等变了即失效。标题变化放入任务上下文变化处理，不简单等同于几何变化或完全忽略。

数据必须注明坐标来源和失败状态。不要把 `visible=true` 理解成所有像素都无遮挡，也不要把某一点命中正确理解成全窗口无遮挡。

### 4.1 正确区分外框、可见外框与客户区

- `GetWindowRect` 可能包含不可见调整边框，并受 DPI 虚拟化影响。
- 需要可见外框时可读取 DWM 的 `DWMWA_EXTENDED_FRAME_BOUNDS`；它与 `GetWindowRect` 的 DPI 行为不同，不能混用未核对的结果。
- `GetClientRect` 获取客户区本地矩形；将角点通过 `ClientToScreen` 转成屏幕坐标。在一致 DPI 上下文中进行调用并核对结果。

来源：[GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)、[GetClientRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclientrect)、[ClientToScreen](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-clienttoscreen)。

观察区域明确标记 `client / window / popup / explicit_region`。客户区不是唯一操作区：关闭按钮、标题栏、部分菜单位于其他区域；独立弹窗也可能是另一顶层窗口。不得通过固定 margin 推断它们的位置。

### 4.2 DPI 是环境信息，不是万能比例

已有 `physical_pixels()` 要复用。采集、几何读取和输入映射需要一致的 DPI 上下文；不要在运行中的 Harness 随意修改进程级 DPI awareness。不同线程/子进程都应自检并在退出时恢复自己的线程上下文。

`GetDpiForWindow` 的返回值受目标窗口 DPI awareness 影响：unaware 窗口可能返回 96，system-aware 与 per-monitor-aware 又不同。记录原始返回值及 awareness；不能把它无条件当成实际显示器缩放率。[GetDpiForWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdpiforwindow)、[Windows 高 DPI 说明](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)。

应用内部缩放、字体设置、响应式布局变化不一定反映在窗口 DPI 中。尺度比只可作为搜索候选，不是坐标正确性的证明。

### 4.3 多屏与遮挡采取分阶段支持

当前 action-ready 观察要求整个区域在一个显示器内。首版保留这条限制并返回明确 `CROSS_MONITOR_UNSUPPORTED`，不要静默只截一部分、改用主屏或自动移动用户窗口。

单屏副显示器和负屏幕坐标应能正确表示；跨屏拼接放在后续单独验收，不能默认“一张跨屏图对应一个 DPI”。

执行前继续做目标点命中检查，并结合目标周围像素证据、窗口关系和前台状态。`WindowFromPoint` 不返回隐藏/禁用窗口，静态文字控件也有特殊返回规则；它不是完整的可见性/可操作性证明。[官方说明](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint)

遇到不支持的透明层、特殊全屏表面、受保护画面或无法判定的弹窗关系，返回 unknown/unsupported；不要声称能重建被遮住的窗口内容。

## 5. 坐标与观察契约

统一矩形表示为 `{left, top, width, height}`，右/下边界排除；屏幕坐标允许负数。对每个点明确标记空间：屏幕物理像素、客户区局部像素、观察图片像素、模型附件像素。

v1 新窗口层仍采用未缩放 action-ready 原图：

```text
screen_x = capture_bounds.left + image_x
screen_y = capture_bounds.top  + image_y
```

这只适用于观察尺寸与 capture_bounds 一致的原图。客户区点先由公共几何层转到屏幕；定位器输出必须标明其所属 observation/context，不能直接丢给另一个观察。

新增几何字段需要加入 observation、click-binding、执行请求和证据校验链。捕获过程采用：读取上下文 A → 截图 → 读取上下文 B；若绑定/几何/前台等发生变化，丢弃行动资格。两次检查仍不是原子保证，执行前必须再次复核。

模型附件可能被宿主规范化，沿用现有附件尺寸核对与映射机制。尚未验收的新缩放/裁剪变换只能作为 `analysis_view`，不得通过修改 manifest 的尺寸或 `resized` 来冒充 action-ready 原图。

### 原图、分析图、参考图的用途

| 类型 | 用途 | 能否直接作为当前点击依据 |
| --- | --- | --- |
| 当前 action-ready 原图 | 定位、执行前检查 | 满足全部现行检查后可以，一次性消费 |
| 当前裁剪/缩略分析图 | 模型理解、候选区域发现 | 首版不可以；回原图重新确认 |
| 历史参考补丁/模板 | 给定位器和验证器提供线索 | 不可以 |

归一化坐标可以表示“右上方附近”等搜索提示，但窗口重排时它不保持语义，不能直接变成点击位置。

## 6. 通用定位接口：局部快路径 + 视觉重规划

建议公共接口：

```text
resolve_window(selector, task_context) -> candidate_result
read_window_context(binding) -> context
observe_window(context, region_spec) -> observation
locate_target(observation, target_spec, reference?) -> localization
execute_checked(observation, localization, grant) -> receipt
verify_transition(before, receipt, expected_spec) -> passed/failed/unknown
```

这些是逻辑接口，可由现有函数适配，不要求新增六个模型工具。特别是 `execute_checked` 必须复用固定执行器，不能出现第二条鼠标输入通道。

`target_spec` 保存目标语义、所属区域、可选视觉参考、上下文锚点和适用条件。`localization` 建议包含：状态 `found/not_found/ambiguous/unsupported`、目标框/中心、observation ID/哈希、context/geometry revision、方法、候选数量和歧义依据。

### 6.1 快路径：历史视觉线索在当前图上确认

先支持同尺度局部重定位，解除“整张新旧图必须同尺寸”的前提时，只解除定位器的输入限制，不能同时解除执行器的当前观察一致性要求。

参考补丁从旧图中提取；候选在新图内搜索。补丁绑定自己的尺度/来源，不要求整张画布等尺寸。窗口相对位置、邻近标签、控件组锚点可以缩小搜索范围，但必须记录可适用范围。

重复图标、两个相似按钮、锚点缺失、补丁超出屏幕或当前图不完整时输出 ambiguous/not_found，不能选“最高分但不够明确”的目标。

### 6.2 多尺度匹配：有限候选，回到原图确认

第二阶段才引入多尺度候选。参考 DPI、字体/应用缩放已知信息，生成有限的候选尺度和区域；设置搜索时间、像素面积和候选数上限。不得无边界扫完整桌面来提高表面成功率。

在候选尺度生成阶段可缩放参考补丁或制作图像金字塔，但执行依据始终是当前原图，返回当前原图坐标。跨尺度候选要进行空间去重后再评估第二候选/歧义，避免把同一个目标在两个尺度下当成两个独立目标。

分数阈值、raw 与 edge 分数不能随意混合排名；需明确各方法的通过条件。尺度候选不是正确性的证据，仍需目标上下文与后置验证。

### 6.3 布局重排：视觉重新定位，不硬推比例

窗口变窄后，按钮可能换行、折叠成更多菜单或消失。这种情况下 DPI 比、客户区宽高比、旧相对坐标都不足以确定新目标。

检测到布局不适用或局部匹配不明确时，重放返回 `replan_required`。普通视觉规划读取足够的当前授权窗口上下文，识别新目标并经公共底座执行。PreAct 的一次重放内部不能悄悄启动模型、生成新步骤继续跑。

如果新布局需要不同步骤，生成新的候选程序版本，经实际验证后再入库；不能修改旧 proof 内容或自动晋升新流程。

## 7. B03 也必须适配，不能只修点击定位

点击找到正确位置后，旧 B03 模板仍可能因为原点、布局、字号变化而失败。定位适配和验证适配应作为同一阶段验收。

- 预期区域明确属于客户区、窗口区或某个锚点；保留参考观察的几何与尺度。
- 客户区平移可重新映射区域；不能无依据平移整张旧截图来证明状态等价。
- 对等比例变化，如果新增对齐/缩放验证器，必须版本化、记录变换并使用负例检验；不沿用原 raw 阈值直接宣称等效。
- critical region 应绑定语义位置或已验证锚点；不能继续检查窗口移动前的屏幕坐标。
- 文字内容决定成功时，单纯外观模板可能不够；补充可靠的内容检查或返回 unknown。OCR 只能是可选观测来源，不是所有任务强制依赖。
- 不支持的布局返回 unknown/replan，不降低全局相似度阈值以追求通过率。

最终结果区分“目标定位成功”“输入送达”“程序声明的后置条件通过”“用户任务完成”。四者不得互相替代。

## 8. 稳定性与 FRAME_CHANGED 的处理

稳定观察顺序：有界等待 → 新 action-ready 观察 → 当前图定位 → 执行前窗口/输入/像素复核 → 一次输入 → 动作后观察和验证。

连续几帧稳定不能保证后续仍稳定。目标附近的原始像素检查继续有效；不能仅通过全屏差异比例低或关掉检查解决 `FRAME_CHANGED`。

建议为拒绝补充诊断：变化框、目标邻域变化比例、前后 context/geometry revision、前台和输入信号变化、定位到复核的耗时。日志只包含必要局部证据，按既有保留策略处理。

重试边界：

1. 首版 `FRAME_CHANGED` 仍按既有协议停止并返回证据。
2. 后续若加入只读重新采集/重定位，必须有次数和总时限；它不能自动重放旧坐标或消费旧观察。
3. 只有回执明确确认拒绝发生于任何输入之前，才可把后续行动视为新的规划请求；发生过鼠标移动也要记录，不能概括为“完全没操作”。
4. 超时、取消、输入状态 unknown 或已经发送点击时，不自动重试动作；先读当前状态。
5. hover 变化与用户接管可能改变画面，不能推断任何变化都是无害动画。无法区分时停止。

## 9. 程序与协议版本迁移

不要直接在现有 v2 已验证程序上补字段并继续使用旧 proof。

当程序语义新增窗口角色、几何依据、定位器/验证器版本与支持尺度范围时，应创建新的程序版本（例如 v3，仅为该程序的新版本号，不意味着所有 schema 都统一升到 3）。观察 schema、授权 schema、locator/verifier 版本分别管理。

- 新程序重新采集依据、验证、生成绑定 proof；proof 覆盖新增语义字段和依赖版本。
- 旧程序不可变。若保留旧执行能力，明确在旧适用范围内执行，不自动升级或放宽；若旧契约无法支持，返回 VERSION_UNSUPPORTED。
- 旧授权不自动变宽；旧观察不能通过补空字段变成新观察。
- 定位/验证算法升级造成语义变化时，既有 proof 的可用性必须明确处理，不能“代码升级了所以都有效”。

## 10. 分阶段实施与代码落点

### W0：冻结边界与补失败诊断

读取现有 P2 失败回执，而不是仅依据聊天截图判断原因。保留当前停止行为；核对 0.6.3 live 状态。建立针对窗口几何、定位和验证的合成样本。

### W1：公共窗口上下文，只读接入

实现/抽取 `window_context.py`，补客户区屏幕矩形、DPI 来源、窗口实例与上下文版本。`single_click.py`、观察脚本、变化策略和 Harness 窗口输出共用它。先保留旧执行契约，验证输出一致，不发输入。

执行器当前比较整个 window 字典：加入时间戳/context_id 后若继续逐字典比较，会每次误拒绝。必须定义显式的 `same_instance / same_geometry / same_task_context` 比较字段；也不能为了消除误拒绝而遗漏安全字段。

### W2：普通操作链先接通，再让重放复用

把客户区/窗口区选择、当前原图、执行前上下文复核接入 `desktop_observe → desktop_click`。程序重放随后调用相同实现，移除自身的固定 margin 几何计算。

先验收平移和单屏尺寸变化；遇布局变化可正确停止。此阶段不承诺模板自动适应任意缩放。

### W3：有限定位增强与 B03 对齐

先解除定位器对整图同尺寸的限制，再引入窗口相对锚点与有限多尺度候选，同时更新验证区域语义。使用新程序版本、新 proof，并校验相似错误弹窗和双目标等负例。

### W4：通用视觉兜底与效率回归

不适用时返回明确重规划原因；普通模型规划通过公共底座重新定位。验证这一流程不引入隐藏模型请求、自动步骤变更或授权扩张。随后继续昨日的请求次数/延迟测量，检查准确性与端到端耗时。

本阶段不扩展输入类型、不新增后台持续录屏、不做图片长期记忆、不启用 PreAct 分支/循环、不改 RAG、不安装 CUDA。现有 MSS/NumPy/pywin32 先用足，不以安装新插件作为开工前提。

## 11. 验收矩阵

### 11.1 离线契约与故障测试

| 场景 | 必须验证 |
| --- | --- |
| 窗口外框含不可见边缘、客户区非零偏移 | 不能按固定边距猜；客户区屏幕映射正确 |
| 负坐标副显示器、右/下边界点 | 物理坐标正确，边界外拒绝，不截断为 0 |
| 同进程/同类多个窗口、同名不同进程 | 返回歧义或准确绑定，不按第一项选 |
| HWND/PID 复用、进程重启、生命周期未知 | 旧绑定失效，不继承旧授权 |
| 标题变化、同窗口切换文档 | 按授权策略区分，不能删标题检查一律放行 |
| 截图前后窗口移动/缩放/换屏 | 本次观察不可执行；几何版本变化可解释 |
| 附件规范化、缩略图冒充原图 | 原协议拒绝仍有效，映射来源不混淆 |
| 同目标多个尺度候选、重复图标 | 候选去重正确，独立目标歧义拒绝 |
| 局部匹配通过但 B03 区域错位 | 不能判任务成功；验证区域绑定可追溯 |
| 极小关键文字变化、相似错误弹窗 | 验证失败/未知，不凭总体相似度通过 |
| DPI API 失败/返回无效值、不同 awareness | 来源与未知状态显式记录，不假装 scale=1 |
| 取消、授权到期、并发输入、输入后异常 | 沿用账本/租约/取消边界，不重试已发生动作 |
| 旧 proof 配新几何/定位语义 | 校验拒绝或明确走旧版本，不静默升级 |

### 11.2 实机分级验收

先在用户准备的计算器、记事本测试窗口完成，只用测试文档，不要求用户为了迁就模板固定窗口位置。

1. 同窗口不同位置：移动前后定位和点击正确，原点更新有证据。
2. 不同宽高/最大化/还原：布局保持时可定位；布局重排时正确重规划或停止。
3. 100%/125%/150% 缩放条件：分别验证几何、目标定位和 B03；设置由用户在方便时配合，不擅自修改系统缩放。
4. 多窗口、标题变动、独立弹窗和遮挡：窗口选对；不能确认的场景零错误点击。
5. 有多屏设备时测试换屏与负坐标；无设备则标记“仅合成测试，现场未验证”，不要求为验收购买设备。
6. 最后执行新版本的已验证单步 PreAct 重放；宿主多步开关继续关闭，直到另行完成多步现场验收。

每项记录：输入场景、context/geometry、观察引用、定位方法/候选、执行回执、B03、模型调用次数与耗时。区分“支持并成功”“保守拒绝”“未测试”；一次成功不等于已证明通用可靠率。

验收底线：所有明确的错窗口/歧义/失效观察负例不发错误输入；正例与基线对照，新增停止率也要报告，不能只展示成功样本。窗口 geometry 正确、grounding 正确、验证正确分开计数。

## 12. 给 DeepSeek 的最终交付要求

先完成 W0/W1，只读阶段输出客户区、外框、DPI、身份与几何版本的对照证据。通过后推进 W2，之后才做 W3 的尺度匹配。每阶段说明实际修改的公共模块、保留的兼容路径、测试覆盖和未支持情况。

不要只给 `desktop_replay` 加补丁。最终应能回答：同一个窗口选择与几何模块是否同时服务普通视觉操作和 PreAct？窗口位置、尺寸、标题和 DPI 变化时，分别是哪一层处理？无法处理时是否停在输入之前？

阶段完成后统一写记录；必要的运行证据与账本继续及时写入。新增临时样本按运行目录清理，保留正式验收证据，不删除用户下载源码、旧程序或 proof。
