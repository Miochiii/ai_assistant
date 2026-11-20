# 常驻陪伴与 Coach：具体接入步骤和开发交接

日期：2026-11-03  
依据：本轮只读检查当前项目源码及本地 `third_party/sources/dsh-see-now-main`。  
性质：实施计划，不代表以下新模块已实现或验收通过。

前置设计：[常驻陪伴助手与 Coach Overlay 融合方案](2026-11-03-resident-companion-coach-overlay-design.md)。本文落实为文件、接口、任务顺序与验收门槛。

## 1. 决策：保留底座，新增常驻 Host，局部替换调度

不推倒整个项目。继续保留桌面动作契约、固定 Medium 执行器、窗口上下文、记忆核心、PreAct 和已完成的 Overlay 视觉。

现有 `coach_host.py` 是一次任务原型：读取固定 plan，启动 Overlay，等待 Next，截图和定位下一目标，任务结束或失败后退出。它不适合继续堆叠聊天、长期观察、会话切换等职责。

新增 Harness/Node 常驻 Host，把旧 Python Host 保留为对照入口；提取其可用定位能力。See Now 的采集、筛帧和陪伴交互可复用，但不能同时启用两套模型唤醒循环、两套用户窗口和两套任务所有者。

目标体验：打开同一个助手 → 陪伴聊天 → 进入软件指导 → 闲聊不中断任务 → 完成或更换任务 → 继续使用，无需重启。

本计划第一轮只做陪伴与只读指导，不新增自动操作，不放宽现有授权，不自动开启长期记忆写入。

## 2. 当前代码依据与需要处理的缺口

| 文件 | 当前实际情况 | 接入处理 |
|---|---|---|
| `tools/coach_overlay/coach_overlay.py` | 已有 `--event-file`、`--host-paced`；支持状态驱动和 Next 事件 | 保留旧模式，增加常驻模式与可靠消息通道 |
| 同上 `_emit_event()` | 替换单个 JSON 文件，只保留最新事件 | 不能承载连续聊天；新模式使用事件队列与回执 |
| 同上 `_tick()` | 无有效任务、目标失焦时连鲸鱼一起隐藏 | 助手外观与任务标记分离；只隐藏失效标记 |
| 同上 `_validate()` / `_emit_event()` | 接收状态用 `_last_generation`，事件输出使用 `self.generation` | 核查并统一“当前已接纳状态版本”，不能假定事件版本已正确同步 |
| `tools/coach_overlay/coach_host.py` | 固定任务、固定时限；初始定位失败或任务结束退出 | 保留 CLI，常驻生命周期移到新 Node Host |
| 同上 `advance()` | 定位下一目标后直接推进 | 增加“当前步骤结果验证”，不能把下一按钮存在当完成 |
| 同上 `locate_text()` | 选择最短的包含目标文字的 OCR 行 | 改为候选输出和歧义处理，不直接作为成功判定 |
| 同上 `capture_screen()` | 直接截显示器 1，保存 PNG | 新接口必须明确观察范围、时间和窗口几何；不要视为已有绑定证据 |
| `plugins/dsh-desktop-observe/image-delivery.js` | 校验单帧来源哈希、尺寸、坐标映射并交附件 | 原路径保持；拼图使用独立交付语义 |
| `src/desktop_adapter/observation_policy.py` | 已有几何比较、RGB 变化块和关键区域分析 | 作为 Coach 区域检查的可复用能力，不重复造完全相同的模块 |
| `src/assistant_memory`、现有动作与重放模块 | 已独立实现并有回归入口 | 保留，通过已有接口调用 |

这是接入检查，不是完整代码审计。上述模块存在不等于其所有场景均已通过实机验收。

## 3. 建议新增目录与职责

以下名称是建议的新文件，不是声称当前已有。

```text
plugins/dsh-assistant-host/
  package.json                 插件声明、依赖和发布文件列表
  cordis.patch.yml             独立注册，不替换原桌面工具插件
  index.js                     注册人类命令、模型工具、释放资源
  resident-host.js             常驻状态、任务生命周期、取消和结果接纳
  protocol.js                  事件、状态、观察、模型结果校验
  ui-channel.js                文件消息队列、回执、状态原子写入
  ui-process.js                Python 界面启动、握手、心跳、关闭
  observation-service.js       观察范围、采集生命周期、当前帧/历史图分离
  see-now-adapter.js            封装固定版本上游模块
  model-session.js             会话绑定、唤醒、请求取消、结果回传
  companion-policy.js          主动交流节奏、去重、待命
  coach-controller.js          步骤、完成条件、验证、下一目标定位
  frame-delivery.js            陪伴图附件交付与保留索引

tools/coach_overlay/
  coach_overlay.py             保留既有入口，新增常驻模式
  resident_panel.py            对话面板，使用同一 Tk 主循环
  resident_channel.py          界面侧通信；不调用模型或执行器
  coach_locator.py             从旧 Host 提取的定位能力
  coach_host.py                保留旧 CLI，逐步改为调用提取模块

scripts/
  coach_locate.py              有界 JSON 输入/输出的只读定位入口
  check_assistant_host.mjs     零 API 的离线接入检查

tests/
  test_assistant_protocol.mjs
  test_assistant_lifecycle.mjs
  test_assistant_channel.mjs
  test_assistant_observation.mjs
  test_assistant_model_session.mjs
  test_coach_controller.mjs
  test_coach_locator.py
```

只在对应阶段创建所需文件，避免一开始搭出大量空模块。首次实现不改变 RAG 环境，不安装 CUDA；依赖和 Harness API 以本机实际版本核对，不照抄上游假定。

## 4. 契约先行

### 4.1 状态与生命周期

状态应分开表达：

```text
assistant: starting | ready | closing | closed | fault
mode: companion | coach | standby
observation: stopped | starting | running | paused | fault
task: null 或 {task_id, status, step_id, target_binding, expected_result}
model_request: null 或 {request_id, status, context_id}
```

任务结束不关闭助手；观察暂停不销毁聊天入口；普通回答结束不关闭观察服务。

运行目录建议：`runtime/assistant-host/<assistant_session_id>/`，由 Host 创建不可复用的新实例标识。与 Harness 的会话 ID 分开记录，不混用两个概念。

### 4.2 界面状态快照

```json
{
  "schema_version": 1,
  "assistant_session_id": "instance-uuid",
  "state_revision": 12,
  "context_epoch": 3,
  "mode": "coach",
  "observation": {"status": "running", "scope_id": "scope-uuid"},
  "task": {"task_id": "task-uuid", "step_id": "step-2", "status": "waiting_user"},
  "bubble": {"text": "请打开文件菜单"},
  "highlight": null,
  "input_enabled": true
}
```

`highlight` 有值时附带 observation ID、获取时间、窗口绑定、物理像素范围及几何版本。无任务时允许 `task=null`，无标记时允许 `highlight=null`，不能因此隐藏整个助手。

`state_revision` 用于呈现顺序；`context_epoch` 用于取消、换任务等语义失效。不要因为聊天列表新增一条导致所有有效观察被误作废，也不要把旧的 `generation` 字段机械用于所有用途。旧状态协议通过兼容转换继续支持。

### 4.3 用户事件

```json
{
  "schema_version": 1,
  "event_id": "event-uuid",
  "assistant_session_id": "instance-uuid",
  "task_id": "task-uuid",
  "context_epoch": 3,
  "client_seq": 27,
  "kind": "chat_submit",
  "created_at": "ISO-8601",
  "payload": {"text": "我这里没有看到这个菜单"}
}
```

事件至少覆盖：`chat_submit`、`typing_started`、`typing_ended`、`check_step`、`skip_step`、`pause_observation`、`resume_observation`、`cancel_task`、`stop_response`、`close_assistant`。

用户控制事件与模型输出走不同接收路径。模型不能仅凭一个 `source=user` 字段获得控制权。文件通道本身也不防同用户恶意本地代码；第一版不经此通道签发执行授权。

### 4.4 消息队列

首版沿用本地文件方案：

- `inbox/`：每个事件独立文件；生产者写临时文件后原子改名。
- `acks/`：按 event ID 回执，区分 accepted、handled、rejected。
- `state.json`：仅界面快照可覆盖；单一 Host 写入。
- `outbox/`：模型回复等不可覆盖的消息事件，界面按 ID 去重。
- `instance.json` 与心跳：记录本次进程及启动标识，不能只凭旧 PID 判定存活。

单实例锁、单消费者、消息大小上限、协议校验和保留上限必须同时存在。序号由生产者生成，不能只按时间戳排序。暂停/关闭优先处理，不能被大量聊天消息拖住。

不宣称跨崩溃 exactly-once：采用可重投、按 ID 去重、处理回执。中途崩溃的模型请求标记结果未知，不能自动重复发送或自动恢复观察。启动后默认待命，旧实例目录不重新消费。

## 5. 实施任务顺序

### RH01：冻结基线与上游接入边界

做什么：

1. 记录当前 Overlay、Coach Host 和相关测试状态；已有失败单独记，不混入本轮回归。
2. 核实实际 Node、Harness、Python、ffmpeg 版本和路径；Python UI 继续用当前可用的 3.12，执行器环境保持不变。
3. 记录 See Now 源码 commit；若下载包无 Git 信息，记录来源 URL、版本和文件哈希。
4. 定义适配器依赖来源。正式部署不能随意读取会被手工替换的 `third_party/sources`；选定本地固定包或带来源记录的 vendor 副本，保留 LICENSE/NOTICE。
5. 确认只注册一个常驻调度者。独立 See Now 插件若同时启用，接入验收前应明确关闭其后台循环，不静默改用户其他 profile。

验收：原入口仍可用；新插件未启用时不启动界面、截图或 API。

### RH02：常驻 Host 与消息通道，完全离线

改动：新增 `resident-host.js`、`protocol.js`、`ui-channel.js`，使用 fake UI/fake model/fake capture。

做什么：实现待命、建任务、结束任务、换任务、暂停、关闭；实现实例隔离、事件回执和迟到结果丢弃。明确助手关闭时资源释放顺序。

验收：

- 连续提交两条消息均收到回执；重复 event ID 不重复处理。
- 同一时刻只允许一个活动指导任务。
- 任务 A 结束后实例仍运行，可建立 B；A 的迟到结果不覆盖 B。
- 暂停和关闭不等待 mock 模型完成；关闭后无 timer/worker 残留。
- 全部测试无截图、无模型请求、无桌面输入。

### RH03：Overlay 常驻界面与聊天面板

改动：`coach_overlay.py` 增加独立常驻入口或模式开关；新增 `resident_panel.py`、`resident_channel.py`、`ui-process.js`。

做什么：

1. 保留原静态、预览、host-paced 模式，不直接替换旧 CLI 的行为。
2. 常驻模式允许无 rect、无 target；把鲸鱼/对话显示与任务高亮分开。
3. 在同一 Tk 主循环内提供可展开聊天 Toplevel；复用上游交互思路，按组件提取，不原样再起整套窗口进程。
4. 输入框允许获得焦点；原透明标记层继续穿透，提示按钮保持独立窗口。
5. 输入时暂停步骤验证并保留原目标绑定；发送后不强制抢回应用焦点。
6. 将“检查当前步骤”和“手动跳过”分开；跳过是未验证推进，不报告成功。
7. 修正当前事件 generation 与已接纳状态版本的关联；新消息加入 event ID。

验收：mock 回复可显示；无任务时助手仍存在；焦点进入聊天框不会让整个助手消失；关闭退出 UI 和 Host。原 `preview.py` 与已有布局测试仍可用。

本阶段完成即可先给用户看，不必等真实视觉和 API 全部接入。

### RH04：持续观察适配，先离线回放，再真实本地采集

改动：新增 `see-now-adapter.js`、`observation-service.js`。

复用：优先调用上游 `capture.js`、`pipeline.js` 的独立接口；由适配器统一包装启动、停止、帧输入与出图。不要调用上游 `index.js/apply()` 来获得整套全局状态，也不并行启动 `loop.js/startLoop()`。`runner.js` 中采集生命周期思路可用，但其聊天和窗口耦合不能直接带入。

建议项目接口：

```text
start(scope, options)
pause(reason)
resume(scope)
stop(reason)
getLatestFrame({after, scope_id, geometry_revision})
takeSummary()
status()
```

以上是新适配接口，不是声称上游提供同名函数。特别注意上游 `pipeline.take()`/`peek()` 是队列头语义，不能直接实现“最新帧”。适配器单独维护有时间戳的最新帧缓存；超过时效或窗口几何改变时重新取图。

做什么：

1. 用合成帧测试静止、窗口切换、小区域变化和大量动态画面。
2. 明确 scope：显示器、区域或窗口。窗口范围变化重新绑定；上游原生不支持的范围由适配器实现裁剪/采集，不能仅写配置就宣称支持。
3. 设置帧缓存、摘要队列容量及过期策略，不能每帧落盘到 results。
4. 使用项目 `observation_policy.py` 的关键区域与几何检查思路补足全局变化分；先保持接口独立，避免每帧启动 Python 子进程。
5. 对当前实际捕获后端验证 Overlay、按钮、聊天窗的截图排除。不能用之前 mss 的结果代替 ffmpeg 后端验收。
6. 暂停时停止采集子进程、清除待发图，恢复时获取新画面。

验收：无 API；无自我气泡触发循环；关窗后自有 ffmpeg 等子进程退出；不能可靠排除助手图像时明确阻断对应自动判断。

### RH05：Harness 模型通道与陪伴交流

改动：新增插件注册、`model-session.js`、`frame-delivery.js`、`companion-policy.js`。

做什么：

1. 阅读本机 Harness API/类型，确认 session、工具返回附件、取消、请求终结和用户命令来源的实际接口。不得从上游用法推断本机必然兼容。
2. 从明确的当前会话建立绑定；不能依赖全局“最近活跃会话”作为持续消息目的地。
3. 复用上游唤醒与用户插话的机制思想，但所有唤醒都经项目 Host；请求排队成功不等于用户已收到答复，补 request ID、终结回执和超时处理。
4. 建立项目自己的“取观察”和“发布回复/指导建议”工具。回复结果必须绑定请求、任务和 epoch；工具名称可由实现确定。
5. 陪伴拼图单独交附件，标记只供理解、不可作为动作依据。不能绕过 `attachObservation()` 的单帧尺寸检查或给拼图附一个假的整屏映射。
6. 用户消息优先；普通屏幕变化合并，单个上下文最多一个活动模型请求。回复期间新图保留最新有效信息，不无限累积唤醒。
7. 初版使用安静陪伴作为默认，允许正常/积极偏好；没有新信息可不回应。
8. 记录必要附件索引和保留信息，避免“记忆核心没存图，但 Harness 附件和历史无限保留”的遗漏。

运行策略：先 fake model 验证全链路，再在实际模型调用已获用户授权且符合当前配置时进行短时验证。不新建 API，不安装未经核对的依赖。

验收：用户发一句能收到一条可追溯回复；不因自动唤醒重复回答；停止当前回答不关闭助手；暂停后没有新视觉请求；旧请求结果不改变当前任务。

### RH06：提取定位能力，接入 Coach 的结果验证

改动：新增 `coach_locator.py`、`scripts/coach_locate.py`、`coach-controller.js`；旧 `coach_host.py` 改为使用提取后的定位模块，保留旧用法。

定位接口：输入限定为 observation 引用、目标描述或补丁配置；输出候选列表、范围、证据和 `found/not_found/ambiguous/unknown`。不接收任意 Python/PowerShell 或 shell 命令。

做什么：

1. OCR 限制到授权观察范围；不要在全屏中挑到聊天记录里的同名文字。
2. 多个相近候选必须输出歧义，不能只选“最短包含行”直接通过。
3. 观察携带坐标原点、DPI/窗口几何、时间和 observation ID；不可把局部 OCR 坐标当全屏坐标。
4. 任务步骤新增 `expected_result`；把结果验证与下一目标定位拆开。
5. 验证结果用 `satisfied/not_satisfied/unknown`，附证据。只有当前上下文的新证据可以自动推进；手动跳过独立记录。
6. See Now 的变化只负责触发检查。当前步骤未满足时继续等待；不能因下一目标碰巧存在而跳步。
7. 无法找到目标时保留对话入口，隐藏失效高亮并解释原因，不退出整个助手。
8. 校验窗口身份和几何必须在取图前后及结果接纳时有明确位置；几何变化后使旧框失效。

验收：步骤完成、未完成、歧义、用户跳过、目标移位、窗口被遮挡、用户正在聊天均有样例；至少验证一个“下一目标一直存在，但当前步骤未完成”的反例。

### RH07：多任务连续使用与有限上下文

做什么：

- 同一个窗口连续运行陪伴、任务 A、闲聊、任务 B。
- 任务切换更新 epoch，取消旧请求并撤销旧任务的排队工作；不继承执行授权。
- UI 历史和模型工作上下文分离。达到阈值时使用受控摘要或干净工作上下文，不把全天截图不断追加。
- 记忆仅通过既有核心接口；不把 `chat.jsonl` 或对话面板历史直接导入长期记忆。
- 区分 capture fault、model fault、UI fault；错误可见且没有后台请求风暴。

验收：长时间运行后缓存、日志和队列有界；重启默认待命；关闭、睡眠恢复、目标窗口销毁、模型超时均可停止或恢复，不自动重放旧任务。

## 6. 哪些行为暂时不做

- 不改变固定 Medium 执行器及其授权检查。
- 不把陪伴观察自动升级为键鼠操作授权。
- 不为接入而重写 SQLite 记忆核心、RAG 或 PreAct。
- 不同时启用两个全局采集/唤醒循环。
- 不把现有 Python Host 改成另一个拥有独立模型上下文的总调度器。
- 不宣称阈值筛帧有语义准确率保证，不拿宣传 token 数作为项目测量结果。
- 不一开始加入摄像头、直播、自动语音输入和所有平台支持；保留接口，逐项接入。

## 7. 测试、上线与回退

每阶段使用有意义的契约和生命周期测试，不为 UI 文案写大量镜像测试。现场验证只操作项目自有面板或受控测试软件；代码检查、离线测试、真实模型验证分别记录。

新增插件默认关闭。第一轮上线只注册新插件，不移除原桌面工具插件。首次需要重启 Harness 时说明是为了加载插件，后续普通任务切换不得要求重启。

回退步骤：关闭新助手 → 等待其自有子进程退出 → 禁用新插件 → 使用原 `coach_host.py` 或 Overlay 入口。不得为了回退删除原证据、记忆库或用户授权文件。若改到状态协议，保留旧格式兼容或显式拒绝，不能静默误解。

验收记录至少区分：

| 指标 | 目的 |
|---|---|
| 总输入/输出 token、模型请求数 | 判断整体消耗，不只看单张图片 |
| 用户消息到可见回执/回复的延迟 | 判断常驻交流是否可用 |
| 关键变化漏检率、误推进次数 | 防止省图但丢失任务结果 |
| 重复消息、旧任务结果拒收情况 | 验证任务与会话隔离 |
| CPU、内存、队列和附件增长 | 验证长时间运行可控 |
| 暂停/关闭后的采集、请求和进程数 | 验证真正停止 |

只清理本轮产生且明确标记的临时文件；保留源码、测试和必要验收证据。不要递归清空项目既有 runtime/results。

## 8. 给 DeepSeek 的首批执行指令

先做 RH01–RH03，不接真实模型、不启动持续截屏。提交：

1. 新常驻 Host 的离线状态机与事件协议。
2. 能双向通信、不会丢连续输入的消息通道。
3. 基于原鲸鱼 Overlay 的可展开聊天面板，支持无任务待命。
4. 本地模拟任务 A → 闲聊 → 任务 B 的演示；关闭后无残留进程。
5. 保留原入口、测试结果和简短变更说明。

这批通过之后再做 RH04 持续观察，随后 RH05 模型陪伴，最后 RH06–RH07 的步骤验证和长时任务切换。执行方向是“保留底座、替换上层调度”，不是整项目重来，也不是在旧 Python while 循环里继续叠加所有功能。
