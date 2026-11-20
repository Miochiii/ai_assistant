# 给 DeepSeek：桌面视觉请求效率优化实施方案

日期：2026-10-27（UTC+08:00）  
项目：`E:\file\agent\ai assistant`  
性质：实施建议与验收要求，**不是已实现或已验证的功能清单**。

## 1. 决策与范围

用户当前关注“截图发给模型判断效率不高”。本轮只编写方案，不修改执行器、不安装插件、不启动模型实验。视频分镜、持续录屏、视觉长期记忆暂缓。

优化顺序：**测量 → 本地等待与变化分析 → 有界已验证程序重放 → 按需发送区域图**。优先减少模型往返次数，其次才是图片面积、编码体积和上下文长度。不要先换模型、装 GPU 依赖或改写整个 Harness。

三个量必须分别统计：

1. 本地采集次数：可以有多次便宜的采样，用于等待稳定和验证。
2. 发送给模型的图片数/像素数/字节数：省图片不一定省模型请求。
3. 模型请求次数：在一次工具执行内完成本地等待或已验证重放，才有机会省掉多轮规划。

**工具返回“未变化”的文字后，Harness 仍可能发起下一次模型请求。不能把“没附图”报告成“零模型调用”。** 附件服务复用同一附件 ID，也不自动等于服务端不重复计量。

不改 RAG 环境，不安装 CUDA。优先使用已有 MSS、NumPy 和本项目验证器；新增依赖确有必要时核对版本、Python 3.14/实际执行环境兼容性和许可证。无需引入一套新的 Computer Use 驱动。

## 2. 已有实现：从这些位置扩展

本次读了以下本地代码与协议。文档和运行中插件可能不同步，开发前核对实际加载版本，不把磁盘版本当成已 live。

| 现有能力 | 源码入口 | 本轮应如何利用 |
| --- | --- | --- |
| MSS 物理像素截图、观察 ID/哈希/区域 | [vision.py](<E:/file/agent/ai assistant/src/desktop_adapter/vision.py>) | 保留原始证据；拆分采集、编码、持久化的耗时 |
| action-ready 观察 | [desktop_click_trial.py](<E:/file/agent/ai assistant/scripts/desktop_click_trial.py>) | 点击之前继续生成当前、可执行的新观察 |
| Harness 图片附件投递 | [image-delivery.js](<E:/file/agent/ai assistant/plugins/dsh-desktop-observe/image-delivery.js>) | 记录附件准备耗时、尺寸、字节数；这不是模型已收到的证明 |
| 点击与动作后附件 | [action.js](<E:/file/agent/ai assistant/plugins/dsh-desktop-observe/action.js>) | 当前启用图片时会尝试附动作后图；优化必须结合独立验证，不能直接全局关闭 |
| Medium 固定执行器、动作后 delta | [executor.py](<E:/file/agent/ai assistant/src/desktop_adapter/executor.py>) | 复用 `changed_delta` 相关逻辑；保持执行前检查原样有效 |
| B03 三态模板校验 | [verify.py](<E:/file/agent/ai assistant/src/desktop_adapter/verify.py>) | 已知状态走本地校验；未知不能算成功 |
| 局部补丁重定位 | [locate.py](<E:/file/agent/ai assistant/src/desktop_adapter/locate.py>) | 重放每步重新定位，不沿用旧坐标 |
| proof 绑定的程序库存 | [inventory.py](<E:/file/agent/ai assistant/src/desktop_adapter/inventory.py>) | 只重放验证通过的特定版本程序 |
| PreAct 调度 | [preact_adapter.py](<E:/file/agent/ai assistant/scripts/preact_adapter.py>) | 已有 activate/observe/locate/execute/verify；先补测量与有限等待 |
| 运行记录和输入互斥 | [runs.py](<E:/file/agent/ai assistant/src/desktop_adapter/runs.py>)、[lease.py](<E:/file/agent/ai assistant/src/desktop_adapter/lease.py>) | 复用运行身份、收尾、取消和互斥；不建第二套账本 |

参照：[动作协议](<E:/file/agent/ai assistant/docs/desktop_action_protocol.md>)、[PreAct 接口](<E:/file/agent/ai assistant/docs/preact_interface.md>)、[当前进度](<E:/file/agent/ai assistant/docs/progress.md>)。

已知边界：当前协议拒绝缩放的 action-ready 观察；B03 是区域模板验证，不是通用语义验证；局部重定位搜索半径有限；单步有现场样本，多步现场可靠性不能从单元测试外推。已有 run ledger、租约和自动 checkpoint 的部分接口，不要重复开发。

## 3. 路由逻辑：本地能够确定的事先本地做

以下是待实现的宿主编排逻辑，不是要求模型用提示词自行遵守：

```text
收到任务 / 继续已授权运行
  → 核对任务、窗口、会话、授权、取消状态
  → 当前观察 + 本地变化分析
  → 已有明确选定的 verified 程序，且当前步骤适用？
      是：新观察 → 局部重定位 → 固定执行器 → 有限等待 → B03
          passed：只推进到该程序中已定义的下一步
          failed / unknown：停止重放，输出证据和 replan_required
      否：按当前问题选择观察区域 → 请求一次视觉规划
  → 不能确定：扩大观察范围或向用户说明，不降低阈值硬执行
```

变化检测的输出是“哪里可能变了”，不是“应该点击哪里”。任何本地分支都不能自行创造新动作、放宽授权、打开其他软件或自动批准新程序。

对于完全陌生的界面，模型仍可能需要逐步介入；这份方案不承诺消除冷启动推理。

## 4. 阶段 P0：先做延迟基线，保持行为不变

### 4.1 统一测量字段

沿用 `run_id / request_id / step_id / observation_id` 关联事件；进程内耗时用单调时钟，跨进程用明确的 span 起止，不直接相减不同进程的单调时间戳。

建议记录：

| 字段 | 含义 |
| --- | --- |
| `capture_ms` | 抓取 RGB 的耗时 |
| `encode_ms / persist_ms` | PNG 编码、保存证据的耗时 |
| `attach_ms` | 宿主保存附件、准备工具结果的耗时 |
| `diff_ms / locate_ms / verify_ms` | 本地变化分析、定位和校验耗时 |
| `process_start_ms` | Node/Python 子进程启动开销，确能分离时记录 |
| `settle_wait_ms` | 等待动作后状态稳定的时间 |
| `model_request_ms` | 宿主请求起点到可用完整响应的时间 |
| `ttft_ms` | 首 token 延迟，可选，不能替代完整响应延迟 |
| `capture_count / images_sent / image_pixels / image_bytes` | 本地采集与发送分别统计 |
| `model_calls / retries` | 来自真实宿主请求事件，包含失败与重试 |
| `route_reason` | 为什么等待、走本地验证、发送窗口图或停止 |
| `verification / termination_reason` | 沿用现有账本字段，不混淆输入送达与任务成功 |

如果拿不到宿主 API 起止事件，`model_request_ms/model_calls` 写 `null` 并注明 `not_observable`；不能把插件自己的 `plugin_model_calls=0` 当成任务没有调用模型。先核对当前 Harness 的真实扩展接口，禁止杜撰 hook 名称或另起 API 客户端绕过宿主。

不记录密钥、完整聊天上下文或截图文字。耗时日志也不能复制一份截图保留体系；沿用现有证据引用。

### 4.2 对照方法

先测当前基线，再分别启用一种优化。相同任务、相同初始状态、相同模型路由和观察范围，交替运行 baseline/候选以减少网络时段偏差。预热和首次运行分开统计。

第一批至少覆盖：静态界面反复观察、记事本已验证的菜单打开、动作后界面延迟出现、小窗口/位置改变、相似错误弹窗。涉及鼠标的实机验证按既有授权执行，等待用户准备窗口即可，不擅自扩展到重要文档。

每个简单正例先做 5 对重复作为工程小样本；报告全部耗时、成功数、失败类型、中位数。少量样本的 p95 只能作为描述，不宣称统计可靠的尾延迟。没有预先承诺加速倍数，也不要求重新逐次计算费用。

P0 交付：测量字段、离线校验、基线表和最大耗时环节。若慢在截图/子进程启动，先处理该处；不要预设模型一定是唯一瓶颈。

## 5. 阶段 P1：有界本地等待 + 变化区域检测

建议新增纯函数模块 `src/desktop_adapter/observation_policy.py`（名称可调整），不直接发输入、不持有模型客户端。先 shadow：只记录建议，实际仍走原逻辑。

### 5.1 双层差分

1. 先核对窗口身份、物理区域原点、尺寸、DPI/显示器配置等；不一致时基线失效，返回 `context_changed`，禁止把不同尺寸图缩放后判成相同。
2. 对同尺寸 RGB 做精确比较；计算差值时先转有符号整数，防止 uint8 相减溢出。
3. 精确相同才可输出 `unchanged`。同时保存时间与状态来源；它只表示本次采样像素相同，不代表应用内部状态未变。
4. 非零变化按块聚合，例如 32×32 像素，输出所有变化块的边界/数量以及原始变化比例。块大小只是起始配置，要用负例调试。
5. 同时计算带像素容差的变化图用于排序/展示，**不能用全屏平均差值很小或感知哈希接近作为放行条件**。关键区域仍用原分辨率独立检查。
6. 若只展示 top-K 区域，必须返回 `omitted_regions`、总变化数和覆盖范围；不能把没展示的变化当成不存在。

v1 不自动学习动态遮罩，不全局忽略小区域。确认截图后端不包含指针时，无需“去掉鼠标”；如果确实有光标、闪烁输入光标，先允许多等待/多调用，避免掩盖提示文字。未来遮罩只能用于稳定性判断，不能削弱执行器目标附近的原始像素检查或 B03 critical region。

### 5.2 等待规则

动作只发送一次；随后本地等待，不让模型反复发“再看看”请求。建议起始参数：采样间隔 150 ms、最多 2 s、连续 3 帧满足稳定条件；均是待校准值，不是已验证阈值。使用可取消等待，单次工具有总期限。

每帧同步核对授权、窗口身份/前台和用户接管信号；不要把执行器自身输入误当成人类接管。无法区分或环境改变时停止，不能在等待中自动重新聚焦。

- 稳定且 B03 预期状态通过：返回 `passed`，记录所用观察与模板。
- 稳定但状态不符：`failed` 或既有协议的 `unknown`，交还规划。
- 一直没变化：到期返回 `unknown / NO_EFFECT_OBSERVED`，不重发点击。
- 始终有动画：到期返回 `unknown / UNSTABLE_TIMEOUT`，不无限等。
- 取消、遮挡、窗口变化：停止；若输入已经发生，保留送达事实。

不把耗时日志缺失当成动作成功；现有 durable ledger 的动作前必需条件也不能因为优化而取消。

### 5.3 采样与证据存储

可让中间 RGB 帧只在有界内存中短暂存在，不要求每 150 ms 都保存 PNG。动作前依据、最终验证帧和失败证据仍按现有规则保存并绑定 ID/哈希。

开始时可以先复用现有截图路径测量；确认编码/落盘确是瓶颈后，再提取“抓 RGB”和“生成证据”两层。不能为了省一次抓取，把已消费的 observation 再包装成可执行观察。

影子运行阶段要求：策略异常回到原有只读观察/停止流程；不得改变点击次数、授权和输入执行行为。

## 6. 阶段 P2：把已验证程序作为一次有界宿主调用

现有 PreAct 已有本地步骤循环。真正减少模型请求，应让宿主一次运行选定的程序，内部逐步验证，最后返回摘要，而不是模型每一步分别调用 observe、click、verify。

实施入口优先复用 `scripts/preact_replay.py` 和 `ProgramReplayAdapter`。如果目前没有 Harness 重放工具，可新增薄桥接工具（例如 `desktop_replay`，这是提议名称），入参只含程序 ID、版本和明确授权的参数，不接收任意代码、任意坐标数组或自动生成的动作序列。

执行条件：

- 用户任务与程序用途匹配；初期显式选择程序，不实现隐式语义自动选程序。
- `load_program` 验证 proof、内容与版本；授权覆盖所有步骤。
- 沿用全步骤 preflight，每一步仍重新 observe/locate/execute/verify。
- 输入租约保持有效；不得因并发缩短等待而允许两个执行器同时操控桌面。
- 设置最大步骤/总时长、取消信号；先仅开放已验收的单步样本，多步经过现场验证再开放。
- 任意 failed/unknown 停止；不在同一执行器里悄悄转为模型自由规划，不自动重试失败点击。

成功时返回紧凑结果：程序版本、完成步数、每步验证状态、证据引用、耗时。中间截图可以不附到模型消息，但必须有本地证据；失败时附必要诊断图。**没有 B03/合适验证器的普通点击，不能按这条规则省略唯一的结果检查。**

“成功”只表达该程序声明的有限后置条件成立，不能从菜单打开推导成文件保存、任务全部完成或其他业务成功。

规划阶段仍可有 1 次模型请求来选用程序，结束后也可能有 1 次总结请求。验收分别统计这些请求与步骤内调用，不宣称整个用户任务永远零请求。

## 7. 阶段 P3：按需区域图与上下文管理

这一步在 P0/P1 后按收益决定，不把裁图当作第一阶段必须项。

### 7.1 选择观察范围

- 首次任务/环境变化：在用户授权的屏幕或窗口范围内获取足够上下文。全屏并不是无条件默认权限。
- 目标窗口已明确：优先完整窗口原图，不盲目发送桌面其他区域。
- 同一窗口内仅局部变化且上下文已建立：可发送变化区域加边缘上下文，最多少量区域，附“上一步动作/预期状态/原窗口尺寸”。
- 变化覆盖面大、多个分散区域、尺寸改变、焦点改变、遮挡或无法解释的弹窗：恢复完整授权窗口；需要越出授权范围时停止或请求扩大范围。
- 裁图不清楚或漏掉目标：只允许一次有限扩大观察；仍未知就返回待规划，防止无限 zoom 循环。

第一次实现只使用未缩放的原分辨率窗口/区域。不要立即加入 JPEG 低质量压缩、任意降分辨率、多宫格、OCR 或第二个视觉模型。字节变少、像素变少、模型 token 变少不是同一个指标。

### 7.2 坐标与证据契约

区分两类对象：

1. `action_observation`：原始、当前、未缩放、完整绑定和执行前检查，一次性消费。
2. `analysis_view`：从观察派生的裁剪/缩略图，只用于理解；保存父观察 ID/哈希、派生图哈希、裁剪矩形、宽高与变换版本，默认 `actionable=false`。

不能把分析图伪装成原图 manifest，不能改 `resized=false` 来绕过执行器。v1 模型若从分析图发现目标，随后获取原分辨率 action-ready 区域并重新确认目标，再执行；必要时这会多一次请求，纳入收益测量。

若将来要把派生图坐标直接映射回原观察，必须单独扩展受测试的协议：原点、缩放、边界取整、附件服务实际尺寸、负屏幕坐标和多显示器都需覆盖。映射成功也不等于观察仍新鲜或操作已授权。

缓存识别结论时至少绑定：项目/会话作用域、任务或问题指纹、原图内容哈希、窗口身份与几何、模型/提示词/策略版本。不缓存可直接执行的旧坐标；缓存命中不能续期授权或跳过新观察。v1 可只保留会话内短期缓存，避免引入新的长期删除负担。

### 7.3 不让旧图片持续膨胀上下文

图片去重应关注最终发往模型的上下文，而不仅是磁盘。核对宿主是否支持保留摘要和证据引用、按需重取原图；不要假设旧工具图片会自动退出上下文。

已有历史图不能偷偷替换成当前截图。恢复会话时旧截图只作历史依据，必须新观察才能行动。任何摘要标注其证据范围；读不到已清理原图时返回 unavailable，不能补造描述。

## 8. 推荐参考的开源源码

这些是设计参考，不是必须安装清单。上游链接核对日期为 2026-10-27；本地源码是用户下载快照，不能当作最新版或本机已兼容证明。未运行第三方测试，未进行完整安全审计。

### 8.1 优先：已下载的 dsh-vision-toolkit

上游：[Anionex/dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit)。本地 `package.json` 为 `@anionex/dsh-vision-toolkit` 0.1.47。

具体入口：

- [pixel_diff.py](<E:/file/agent/ai assistant/third_party/sources/dsh-vision-toolkit-main/vendor/agent-vision-toolkit/skills/vision-tools/scripts/pixel_diff.py>)：按网格给出差异区域排名，可以参考输出格式和“局部展开”思路。
- [evidence-cache.ts](<E:/file/agent/ai assistant/third_party/sources/dsh-vision-toolkit-main/src/evidence-cache.ts>)：会话作用域、提示词/运行配置指纹、容量约束，可参考识别缓存失效设计。
- [image-input-variants.ts](<E:/file/agent/ai assistant/third_party/sources/dsh-vision-toolkit-main/src/image-input-variants.ts>)：图片能力路由与证据转换边界；已有原生视觉模型时，不要无端增加“另一个模型描述图片→主模型再理解”的双模型往返。
- [image-compress.spec.ts](<E:/file/agent/ai assistant/third_party/sources/dsh-vision-toolkit-main/tests/image-compress.spec.ts>)：后续研究压缩时的测试参考，不是现在直接启用的依据。

不能照搬：`pixel_diff.py` 为页面复刻比较而设计，会把尺寸不同的重建图缩放成原图尺寸，并按灰度均值排序；桌面动作中尺寸改变必须使基线失效，颜色/小字变化也不能被均值吞掉。它依赖 Pillow，本轮无需为读它安装依赖。

### 8.2 优先：已下载的 Orb

本地入口：

- [windows.ts](<E:/file/agent/ai assistant/third_party/sources/dsh-orb-cordis-main/packages/computer-use/src/windows.ts>)：截图区域与输入采用物理像素的组织方式。
- [screenshot.spec.ts](<E:/file/agent/ai assistant/third_party/sources/dsh-orb-cordis-main/packages/computer-use/tests/screenshot.spec.ts>)：多屏截图和屏幕索引对应、数量不一致拒绝等测试。

本项目已经参考过这条坐标路线，重点补齐派生图与原图的明确区分，不另装 Orb 来替换现有固定执行器。Orb 这些模块不等于已经实现了本方案的增量路由或免模型重放。

### 8.3 设计参考：dsh-video-storyboard（暂不接入）

上游：[SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)，本次在线 `package.json` 为 0.2.1。

- [src/index.js](https://github.com/SAOS-3624/dsh-video-storyboard/blob/main/src/index.js)：探测/概览/展开的工具分工。
- [src/pipeline.js](https://github.com/SAOS-3624/dsh-video-storyboard/blob/main/src/pipeline.js)：有界文本索引、按范围续读、CLI/工具共用管线。
- [src/sheet.js](https://github.com/SAOS-3624/dsh-video-storyboard/blob/main/src/sheet.js)：编号与可引用的视觉片段。

仅借鉴按需展开和证据索引。视频代表帧、裁切拼图不能替代动作前后完整证据；README 的固定每图 token 数不能直接用于本项目计量。不要为此安装 FFmpeg、ASR 或增加录屏；这些不属于当前优化范围。

### 8.4 已下载游戏插件：借鉴增量事件，不借用专用状态假装通用视觉

[dsh-minecraft/lib/bot.js](<E:/file/agent/ai assistant/third_party/sources/dsh-minecraft-main/lib/bot.js>) 的增量事件和动作后状态检查，可参考为桌面事件游标。桌面只能记录实际可知的前台/几何/输入/像素变化，不得把推测的业务状态当成事件事实。多消费者不照搬全局消费日志方式。

详细参考见[已有游戏插件文档](<E:/file/agent/ai assistant/log/2026-10-27-game-plugins-reference-for-deepseek.md>)，本轮不重建 runner、账本或租约。

### 8.5 低优先级外部路线

[UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) 可作为整体 GUI Agent 架构的后续参考；[OmniParser](https://github.com/microsoft/OmniParser) 是屏幕解析路线。两者本轮仅核对官方仓库定位，未审阅相关实现、运行或选型，不列入本阶段依赖。增加解析模型有额外推理和维护开销，不能先假定能降低端到端延迟。

**现在无需再下载项目。已有 toolkit、Orb、PreAct/B03 足够完成 P0–P2。**

## 9. 最小测试与上线门槛

### 9.1 离线回归：先验证不漏变化、不扩大动作能力

| 样本/故障 | 期望结果 |
| --- | --- |
| 同尺寸完全相同 RGB | unchanged；不判成功、不创建新点击依据 |
| 关键数字/按钮状态只有很少像素变化 | critical 区域可见；不能被全局低差异或 top-K 丢弃 |
| 等亮度但不同颜色 | 原始 RGB 检出变化，不能只依赖灰度 |
| 原点、DPI、尺寸、显示器配置变化 | 基线失效；旧坐标不可执行 |
| 目标以外出现小弹窗 | 变化未静默丢失，恢复上下文或 unknown |
| 光标闪烁/持续动画 | 有界等待；到期 unknown，不无限采样 |
| 动作无效果、按下后超时 | 不自动重试，保留 input_delivery 与 unknown |
| 相似错误弹窗、双目标 | 不凭单一全局相似度放行；ambiguous/unknown 时停止 |
| action-ready 图被缩放/裁图冒充 | 执行器原有拒绝仍然生效 |
| 用户接管/授权到期/取消/另一输入请求 | 停止或 DESKTOP_BUSY，不继续隐藏后台动作 |
| 缓存跨任务/会话/问题/模型版本 | 不错误命中；缓存也不能授权 |
| 一次图片投递被重试 | 幂等结果与真实请求统计一致，不重复点击 |
| 旧证据被删除 | unavailable/unknown；缓存不能让已删除内容重新注入 |
| shadow 与旧路径相同输入 | 点击次数、授权和最终判定不变 |

“状态相似”与“可以执行”分开断言。纯函数测试用合成小图和现有已许可证据即可；不要以调用真实模型来测试每个分支。

### 9.2 实机验收

1. 单步已验证菜单操作：验证本地完成、仍有 before/after 证据、B03 passed。
2. 相同任务的窗口变化/遮挡/歧义负例：观察是否按预期停止，而不是优化后越过边界。
3. 只读静态与局部变化场景：分别统计抓图、附图和模型请求数。
4. 再验证多步；每一步失败必须立即停止，不能用整段最终外观掩盖中间错误。

建议性能门槛：已知流程的步骤内模型请求应实际减少；若请求可观测，目标为本地重放步骤内 0 次，任务前后对话另计。总耗时是否改善以成对样本为准；调用少但变慢也要如实报告。

可靠性门槛：上述负例没有错误放行；正例成功率不劣于基线小样本；失败/未知不被删除以美化耗时。零错误样本只是本次验收结果，不是长期误操作率保证。

## 10. 给 DeepSeek 的执行顺序与交付

1. 核对磁盘代码和 live 插件版本；阅读本文件列出的已有模块，避免重做。
2. **先做 P0 + P1 shadow**：增加计时与纯函数变化检测，保持原有输入行为。新增模块名和配置项是建议，不要求照抄。
3. 产出一次基线报告：最大耗时环节、每任务模型请求/图片数、错误类型，以及下一步优化选择。若宿主调用数不可观测，明确列为未验证项。
4. 之后接入有界等待，再开放单步 verified 重放的宿主桥接；确保取消、租约、授权、proof 和三态校验回归通过。
5. 前面收益确定后再做 P3 区域图；需要改坐标协议时另列契约变更，不夹在压缩补丁里。
6. 最后统一更新一次记录与验收结果，不在每个步骤生成冗长叙述日志。运行时必要的证据/账本仍须及时写入，不能为了省文字取消。

建议保留三个可独立回退的开关：`observation_policy_mode=off|shadow|on`、`bounded_wait_enabled`、`verified_replay_bridge_enabled`。配置默认保守；原有工具路径可用。关闭优化不能删除证据、关闭授权或隐藏 unknown。

最终交付说明应回答：省了多少次真实模型调用、每个成功任务快了多少、哪些失败仍需模型、是否出现任何误放行。不要用“图片缩小了多少”代替这些结论。

本方案不改变 Memory v1 的权限：视觉分析只能形成候选/运行证据，不能自动 promote 长期事实，更不能凭记忆摘要生成已验证程序。
