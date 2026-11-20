# Coach Overlay、社区视觉检测与 Jev 动作评审：技术决策和下载交接

日期：2026-11-02。工作目录：`E:\file\agent\ai assistant`。

本文汇总新版 `log/user_write.txt` 的评审，以及随后关于 Jev 外部动作评审的讨论。供 DeepSeek 接手时定位方向、准备依赖和安排实验。

**状态：设计与资料核对完成；尚未实现 Overlay、接入新检测器或调用 Jev。本文不代表 live 验收。** 本轮只写文档，不安装依赖、不下载权重、不启用 CUDA、不修改已有 RAG 环境或生产权限。

## 1. 决策摘要

1. 优先做只读 Coach Overlay：复用当前识别得到的 bbox，显示高亮、箭头和中文步骤，由用户自行操作。先验证提示位置和状态失效，不依赖新增本地模型。
2. 视觉增强顺序：RapidOCR 补文字候选，再实验 OmniParser 图标检测。检测器提供候选，不直接发出点击或签发输入许可。
3. Jev 定位为可替换的候选动作评审器。先旁路评分，不改变既有动作放行；在本项目数据上证明能降低错误放行后，再评估是否参与低影响动作路由。
4. 原有 Medium 执行器、观察绑定、授权、取消、事件记录、释放处理和后置验证继续保留。模型高分不替代这些检查；生产拖拽禁用条件不变。
5. 普通网页输入可优先研究受限 DOM provider；桌面通用输入继续研究 UIA/IA2。按平台能力适配，不按具体网站/应用名编写底层放行规则。
6. 用户在场的未验证辅助输入可以作为独立产品能力设计，但不是本轮实现事项，不作为失败后的自动降级，不暴露为模型可开启的参数。

这份文档扩展了前一份接收器评审的产品路线；**不自动撤销前文确定的生产限制，也不授权开启人工监督输入或付费实验。**

## 2. 总体架构

```text
用户任务 → 应用注册表/固定启动器 → 任务规划
                                  ↓
              截图、窗口身份、UIA/DOM、OCR/图标检测
                                  ↓
                         统一候选元素集合
                                  ↓
                         模型选择候选动作
                                  ↓
                 可选动作评审器（Jev 等，先旁路）
                                  ↓
               ┌──────────────────┴─────────────────┐
        Coach Overlay                         执行策略
      高亮、箭头、步骤                  授权 + 必要条件 + 评分策略
               ↓                                    ↓
          用户自行操作                      固定 Medium 执行器
               └──────────────────┬─────────────────┘
                          新观察与结果验证
                                  ↓
                   日志 / 候选程序 / 经验证的 PreAct
```

建议候选记录携带 `observation_id`、窗口身份、`geometry_revision`、bbox、坐标空间、来源及版本、文字/描述、来源分数、采集时间。OCR 原文与模型生成 caption 分开保存；不同来源的分数不直接平均成一个“安全概率”。

建议按三个维度描述权限，避免把证据等级、监督方式和业务影响混成一条等级链：

| 维度 | 取值示例 |
| --- | --- |
| 接收器证据 | native verified / provider verified / unverified |
| 操作影响 | 读取 / 草稿编辑 / 提交或高影响 |
| 监督方式 | 用户在场 / 已验证窄流程无人值守 |

接收器已验证的发送动作仍是 commit；游戏日常使用 PreAct 也不自动变成低风险。

## 3. Coach Overlay 设计

### 3.1 推荐实现与开源参考

首版建议独立 **C# / WPF + Win32 互操作**进程。WPF 绘制框、箭头和中文文字，Win32 管理不激活、穿透、窗口生命周期。此选型是工程建议，不是已验证结论。

- [ClickableTransparentOverlay](https://github.com/zaafar/ClickableTransparentOverlay)：Apache-2.0，Win32 + ImGui.NET；README 列出 .NET 8、Vortice、ImageSharp 等依赖。适合参考窗口与渲染实现，不能默认其输入处理就是符合本项目要求的教学层。复用前检查实际版本、中文字体、DPI、抢焦点行为及依赖许可。[依赖说明](https://github.com/zaafar/ClickableTransparentOverlay/blob/master/README.md)
- [GameOverlay.Net](https://github.com/michel-pi/GameOverlay.Net)：MIT，Direct2D 透明穿透窗口，但仓库于 2024-04-12 归档。本轮不下载、不选作核心依赖。

### 3.2 窗口行为

- 使用不激活的显示/位置更新方式；置顶使用 `SetWindowPos(HWND_TOPMOST, ..., SWP_NOACTIVATE)`。
- `WS_EX_NOACTIVATE` 防止成为前台；代码也不能主动抢焦点。
- `WS_EX_TOOLWINDOW` 用于避免出现在 Alt+Tab；避免 `WS_EX_APPWINDOW`。
- 透明画布完全穿透，暂停/关闭/步骤列表放在独立控制面板或托盘，不让整块画布一会儿穿透、一会儿吞输入。
- `WS_EX_TRANSPARENT` 一般涉及绘制顺序；对 layered window，微软明确说明该样式允许鼠标消息传到下方窗口。必须验证实际后端，不能将“视觉透明”当成“鼠标穿透”。[窗口样式](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles)、[分层窗口命中测试](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features#layered-windows)
- 只在当前目标处于教学状态时显示。目标关闭、最小化、切换到其他应用或被遮挡时隐藏。
- 心跳超时、消息乱序或旧 generation 的更新不能恢复过期标记。Overlay 失联时应撤下画面，不影响执行器。
- “下一步”意味着重新观察并检查完成条件，不意味着无条件推进状态机。

### 3.3 坐标与失效

跨模块统一使用物理桌面像素；渲染器自行换算为 WPF DIP 等局部单位：

```text
检测/模型坐标 → 撤销缩放和 letterbox padding → 原图像素
            → 加截图桌面原点 → Overlay 局部坐标
```

记录完整变换，不只保存一个倍率。处理负桌面坐标、混合 DPI、窗口跨屏、显示器插拔和远程会话分辨率变化。建议 Per-Monitor V2，并按显示器建立 Overlay 窗口；DPI 改变时重新计算字体、几何及位置。[Microsoft DPI 指南](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)

窗口缩放、DPI/布局变化、滚动或页面导航时先隐藏旧 bbox，再重新定位。UIA 元素可以重新查询矩形，但不能仅凭旧 RuntimeId 延续许可。OCR/检测框绑定具体 observation；短 TTL 不能替代状态变化检测。

### 3.4 截图污染及支持边界

Overlay 的箭头和文字可能被自己的截图/OCR 再次识别，污染候选与帧差。可以对自身窗口尝试 `WDA_EXCLUDEFROMCAPTURE`，但必须验证实际截图后端；不可靠时走“隐藏并确认 → 截图 → 检查当前状态 → 恢复有效提示”。此 API 不是覆盖所有捕获路径的安全保证。[接口文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)

首版验收普通窗口、最大化和无边框全屏。独占全屏游戏不承诺覆盖，不以注入/游戏 Hook 兜底；锁屏及安全桌面暂停。RDP 优先使观察和 Overlay 处在同一远程交互会话；本地覆盖远程桌面画面必须另处理客户端缩放、黑边和滚动。游戏兼容和条款需按目标核对，不能承诺外部 Overlay 一定被允许。

## 4. 社区视觉检测的选择与边界

### 4.1 RapidOCR：先补文字候选

[RapidOCR](https://github.com/RapidAI/RapidOCR) 提供文本框、识别文字和分数；不是图标语义模型。官方列出 Windows 支持，支持 ONNX Runtime CPU 等部署路线，当前发布页列出 v3.10.0；代码及 README 所列转换权重采用 Apache-2.0。[部署及模型许可](https://github.com/RapidAI/RapidOCR/blob/main/README.md)、[发布记录](https://github.com/RapidAI/RapidOCR/releases)

先考虑 CPU ONNX 路线。具体模型包体积、Python 3.14 wheel、中文小字体准确率及延迟需根据锁定版本检查，不把 README 中的平台支持当作本机兼容证明。

### 4.2 OmniParser：图标候选实验

[OmniParser](https://github.com/microsoft/OmniParser) 提供现成的界面区域检测权重，并可结合 OCR 与图标描述。第一轮只实验检测部分加 OCR；不默认加载描述模型，避免与现有视觉模型重复推理。

权重差异必须区分：原 `icon_detect` 是 YOLOv8、AGPL-3.0；新增 `icon_detect_v3` 是 YOLOv9-E、MIT；`icon_caption` 标为 MIT。v3 模型卡给出 CPU TorchScript 推理示例，检测类别是交互区域，不是“保存/删除/购买”等业务类别。[模型卡](https://huggingface.co/microsoft/OmniParser-v2.0)

核查时 v3 PR 路径的检测文件约 281 MB，caption 权重约 1.08 GB；下载体积不等于内存/显存。[v3 文件](https://huggingface.co/microsoft/OmniParser-v2.0/tree/refs%2Fpr%2F37/icon_detect_v3)、[caption 文件](https://huggingface.co/microsoft/OmniParser-v2.0/tree/main/icon_caption)

重要不一致：仓库 README 徽标写 MIT，根目录 LICENSE 当前却为 CC-BY-4.0。不能把整仓库宣称为全 MIT；实际复用前按固定提交、文件和权重核对，必要时向上游澄清。当前 README 仍涉及 v3 的 PR revision，应保存版本/哈希，不能混用不同代加载器。[README](https://github.com/microsoft/OmniParser/blob/master/README.md)、[LICENSE](https://github.com/microsoft/OmniParser/blob/master/LICENSE)

官方给出的 V2 A100/4090 每帧约 0.6/0.8 秒不能外推为 3070 Laptop、CPU 或新 v3 的实测结果。完整 pipeline 的 Windows、ONNX/TensorRT 导出兼容也未在本项目验证；底层 YOLO 有导出能力不等于整套 OCR/caption/后处理已经支持。[性能说明](https://huggingface.co/microsoft/OmniParser-v2.0)

### 4.3 其他项目与评测

[UIED](https://github.com/MulongXie/UIED) 可参考传统视觉组件合并；Apache-2.0，但 README 仍列 Python 3.5/OpenCV 3.4.2，并默认使用 Google OCR。当前不下载，避免维护和外部服务成本。[README](https://github.com/MulongXie/UIED/blob/master/README.md)

不需要自行训练即可试用现有模型，但不保证无需适配。通用 YOLO 不天然认识某个游戏 HUD。检测器不能证明密码、只读、选区、授权或业务完成。

对同一批已有测试截图比较：目标候选召回、漏检、重复框、中文文本识别、坐标误差、P50/P95 延迟及资源峰值。覆盖 DPI、主题、窗口大小、PR 面板布局；截图评测记录与模型训练标注是两回事，不要求本阶段建立训练数据生产流程。

## 5. Jev：外部动作评审，先旁路验证

### 5.1 已核查的接口事实

Jev 可以产生结构化决策，但结构化不等于正确：

- `Noul.noul` 是回答“是”的概率，没有另一个原生 confidence 字段。[Noul](https://docs.typesafe.ai/primitives/noul)
- Choice/Score 的 `confidence` 是由输出分布计算的统计量，不能直接等同实际正确率；Score 等级分值也不是正确概率。[Confidence](https://docs.typesafe.ai/confidence)
- 官方将 RLCD 描述为校准决策训练，并指出校准针对预测群体，不保证某一次回答。[AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)
- 官方现在支持图片及 Box，但明确标为尚未生产就绪的实验能力，接口和准确率可能变化。需显式开启实验请求头；本项目尚未启用。[Images](https://docs.typesafe.ai/images)、[Box](https://docs.typesafe.ai/primitives/box)

因此不要把“接上 Jev”写成“已经完成动作置信度校准”。实际存在三个独立步骤：评审器产生预测、用本项目真值检查/校准预测、制定放行策略。

### 5.2 证据不能只来自生成模型的解释

如果生成模型把删除按钮误标为保存，再把“保存按钮＋点击保存”的描述交给 Jev，评审可能只证明描述自洽。

评审输入应包含用户目标、原始截图/保留上下文的局部图、来自 OCR/UIA/DOM/检测器的证据及来源、候选动作、对应 observation 和坐标信息。生成模型的解释只是待检验主张。不同模型不保证错误独立；页面文字和 OCR 内容应视为数据，不能成为修改评审规则的指令。

只评估明确的问题，例如目标语义是否匹配用户意图；越界、点在框内、窗口身份、授权、焦点、取消等可确定检查继续由代码完成。

### 5.3 数据来源与阈值

`jev-eval` README 的 0.82 门槛、58.7% 覆盖、94.6% 准确率是 `team` 分类的示例输出，样本数 412，并列出 91.2%–97.9% 准确率区间；不是 GUI 点击保证。[jev-eval](https://github.com/CMaintz/jev-eval)

关于对话中 ECE=0.052 的引用，找到研究作者页面报告校准结论不确定，主要任务涉及编码代理和破坏性命令，并非 GUI grounding；本次未能打开论文附件，未独立复核具体数值计算。[作者说明](https://www.silt-seb.com/studies/decision-models)

重点指标应为放行集合的错误率、错误动作被放行的比例、覆盖率、危险错误漏检、跨应用/DPI 泛化，以及延迟/费用。ECE 辅助使用，不能仅凭总体 ECE 宣称安全。

校准集与最终测试集按会话/任务/应用分组，避免相邻截图泄漏。加入错误窗口、同名按钮、遮挡、目标不存在、旧截图、缩放错误等负例。真值来自受控测试环境或独立核验，不由被评审的模型自行给标签。

固定模型版本、问题措辞、候选提取版本和数据切分。预先确定评估指标；不要不断调门槛直到测试集通过。跨版本、主题和应用变化后重新验证。阈值校准不能给缺失的接收器证据补真值。

### 5.4 接入顺序

```text
冻结观察/候选/动作 → Jev 旁路打分 → 与真值比较
                              ↓
对照：现有规则与模型 / 原模型再次复核 / 加 Jev
                              ↓
独立测试集显示错误放行确实下降
                              ↓
先影响 Coach 目标选择，再评估低影响动作路由
```

正式放行需同时满足授权、必要证据、经验证评分策略和执行前状态复核。中间分数优先补充新证据或重规划，不反复问到高分为止；服务失败时不能静默当成通过。

`jev-eval` 是社区 MIT 评测工具，不是 Jev 模型权重，也不是官方生产门禁。其 `run` 会调用付费 API；分析已有缓存才是本地工作。视觉请求/Box 与当前工具输入格式是否完整兼容，需要检查实际代码，不能假定下载即能评测截图。当前只下载源码，不运行调用、不提交截图或密钥。

## 6. 其他场景决策

### 6.1 应用启动器

用户配置 `app_id → 固定可执行路径/受限参数/窗口身份与就绪条件`。不允许模型拼接任意路径或 shell 命令。状态链：启动请求 → 进程/单实例复用 → 窗口出现 → 身份匹配 → 主界面就绪 → 按需前台。

启动画面、更新器、登录框和恢复对话框不能当作主界面；超时报告状态，不盲目再次启动。`WaitForInputIdle` 仅是辅助信号，不证明业务加载完成。[Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-waitforinputidle)

### 6.2 网页与专业软件

普通网页 input/textarea 优先研究受限 DOM provider，以用户触发的扩展权限绑定 tab/frame/文档生命周期；导航后作废。先提供证据，输入仍走固定执行器。跨域 iframe、封闭 Shadow DOM、自绘编辑器另行验收。[Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

Adobe 文档列出 Premiere 25.6 支持 UXP，业务 API 可用于序列、轨道、项目项等操作与结果验证；不等于能取得所有原生按钮 bbox。Coach 负责位置提示，UXP 负责有正式接口的业务状态，UIA/OCR/视觉补充屏幕锚点。旧 CEP/ExtendScript 按安装版本评估，不依赖非公开接口。[Premiere UXP](https://developer.adobe.com/premiere-pro/uxp/)、[支持版本](https://developer.adobe.com/premiere-pro/uxp/introduction/)

### 6.3 监督输入与消息查看

监督输入若日后开放，必须由宿主绑定本次窗口/区域、内容、长度、短有效期和单次使用；保留焦点/取消/释放检查，回执明确未验证，不自动重试或 promote。模型不能自行开启。已知密码、命令入口和高影响目标继续拒绝。

“只输入不按 Enter”仍可能触发自动保存/同步，不是底层可普遍保证的纯草稿语义。用户在场也不等于已经看见并批准所有副作用。

不打开会话、不改变已读状态时，只总结当前可见预览；不要承诺完整未读摘要。游戏日常限经验证窄流程，未知界面、资产/购买等节点停止。

## 7. 实施顺序与最小验收

| 阶段 | 工作 | 验收重点 |
| --- | --- | --- |
| 1，优先 | Coach Overlay，用现有 bbox，不引入新模型 | 穿透、不抢焦点、中文绘制；混合 DPI/负坐标；变化即隐藏；截图无污染；失联撤下 |
| 2 | RapidOCR CPU 候选实验 | 中文小字、文字框坐标、已有候选是否增加有效覆盖、延迟 |
| 3 | OmniParser 检测部分，独立环境 | 图标候选增益、漏检/重复、资源与许可；不接执行权限 |
| 4 | Jev 旁路评测，需另有实验授权与真值数据 | 对照基线、独立数据、风险—覆盖关系、版本漂移与成本 |
| 后续 | DOM/UXP 场景适配和监督模式 | 独立授权、生命周期、真实后置验证；不扩大无关能力 |

首个 PoC 只需要一块矩形、一个箭头、一行中文步骤、窗口状态监听和隐藏/关闭入口。验收包含在有颜色的边框/文字上点击仍送达原软件；用户操作后重新观察，而非直接标成功。

本地模型实验保持第二条线，不能借此次下载把尚未成熟的模型引入第一条生产线路。只有资源、版本与许可核对后才决定独立环境方案，不往当前 Python 3.14 `.venv` 批量安装第三方 requirements。

## 8. 手动下载清单与准确位置

已检查现有 `third_party/sources`：下列四项目前均未下载。继续沿用现有目录，不另造一套 vendor 布局。

- 原始 ZIP：`E:\file\agent\ai assistant\third_party\downloads`
- 解压源码：`E:\file\agent\ai assistant\third_party\sources`

| 优先级 | 项目与下载入口 | 预期解压目录 | 用途 |
| --- | --- | --- | --- |
| 先准备 | [ClickableTransparentOverlay](https://github.com/zaafar/ClickableTransparentOverlay) | `third_party/sources/ClickableTransparentOverlay-master` | Overlay 源码参考；不代表最终采用整个库 |
| 先准备 | [RapidOCR](https://github.com/RapidAI/RapidOCR) | `third_party/sources/RapidOCR-main` | 本地 OCR 候选实验 |
| 后续实验，可一并下载源码 | [OmniParser](https://github.com/microsoft/OmniParser) | `third_party/sources/OmniParser-master` | 检测器/候选合并逻辑参考 |
| 后续评审，可一并下载源码 | [jev-eval](https://github.com/CMaintz/jev-eval) | `third_party/sources/jev-eval-main` | 校准与风险—覆盖评测参考；不是模型 |

在 GitHub 页面选择 **Code → Download ZIP**，ZIP 放 downloads，解压出来的顶层目录直接放 sources。保留完整源码及 LICENSE；避免 `sources/项目名/项目名/README.md` 的重复嵌套。若下载 release/tag 导致目录后缀不同，可以保留，不必强行改名。

此时下载默认分支是为了代码阅读，不等于锁定部署版本。接手后记录原始 ZIP 名、下载日期、压缩包哈希、能识别的标签/提交和依赖清单，再选择实验版本。当前不会自动下载/安装任何项目。

**本轮暂不需要下载：** OmniParser/OCR 模型权重、CUDA、完整 OmniTool 虚拟机、Jev 第三方复刻模型、GameOverlay.Net、UIED。也不要求配置 Jev API key。以后进入权重实验时再提供精确文件、revision、许可和独立存放位置，避免下载错代权重或提前占用资源。
