# RH04 离线观察核心记录

日期：2026-11-03  
性质：离线实现；没有真实屏幕采集、ffmpeg、模型请求或桌面输入。

## 完成内容

新增：

```text
plugins/dsh-assistant-host/observation-service.js
plugins/dsh-assistant-host/see-now-adapter.js
plugins/dsh-assistant-host/mss-adapter.js
tools/coach_overlay/capture_once.py
tests/test_assistant_observation.mjs
tests/test_assistant_observation_host.mjs
```

`ObservationService` 提供 RH04 计划中的核心接口：

```text
start({scope})
pause(reason)
resume({scope})
stop(reason)
pushFrame(frame)
latest({after, scopeId, geometryRevision, maxAgeMs})
takeSummary()
status()
```

本阶段只接受合成帧，不调用采集后端。

## Host 注入

`ResidentHost` 现在可注入：

```text
observationService
captureAdapter
defaultObservationScope
```

- `resume_observation` → service.start/resume + 一次 capture
- `pause_observation` → service.pause，清空 latest
- `end_task` / `close` → service.stop
- 采集失败 → observation fault，不推进任务

`captureAdapter` 为空时仍保持旧的状态兼容；有 adapter 时才真正取图。

## mss 单帧适配器

`mss-adapter.js` + `capture_once.py`：

- 不依赖 ffmpeg
- 通过 `.venv` Python 的 mss 抓一帧
- 返回 path/width/height/time/bounds
- 不轮询、不启动后台采集
- 只有 Host 显式 resume 且注入了 adapter 才调用

实测：

```text
frame_id=frame-1793711072545
width=2560
height=1440
image_ref=runtime/assistant-observation/test/frame-*.png
```

本阶段没有把 mss adapter 默认注入常驻 demo；它需要显式配置，避免“一打开助手就开始截屏”。

## 连续观察 runner

新增 `mss-observation-runner.js`：

- 默认 2 秒间隔，可显式指定（最小 250ms）
- 同一时刻只允许一次 capture
- start 立即抓一帧，然后定时
- pause/stop 清理 timer
- 采集错误回调，不抛出到 Tk/主循环
- 进程退出时 timer `unref`，不阻止干净关闭

实测 500ms 间隔、1.6 秒：

```text
count=3
latest=frame-1a9ed786-8eef-4f20-a227-aeaff49eb46c
width=2560
height=1440
status=stopped
```

真实 Host + runner 500ms、1.3 秒：

```text
running: frames_seen=2, frames_kept=2
pause:   status=paused, frames_kept=0, runner=paused
```

这只是“持续取帧”，还没有变化分、筛帧或模型。

## 本地帧差

`capture_once.py` 现在支持 `--previous-rgb`，并输出：

```text
changed_score   0..255，32×18 采样网格平均差
changed_ratio   超过阈值 8 的格子比例
change_bbox     变化格子的近似边界
first_frame     是否首帧
raw_path        当前采样原始 RGB
```

`mss-adapter.js` 按 scope 保存上一帧 raw，下一次捕获传入并删除旧 raw，避免无限
累积。首帧 `changed_score=0`，没有伪造变化。

实测连续两帧：

```text
first:  score=0, first_frame=true, bbox=null
second: score=1, ratio=0.0243, bbox={left:0,top:84,width:2312,height:1271}
```

这个分数只是本地粗粒度变化，不是语义识别，也不唤醒模型。

## 低变化丢弃

`ObservationService` 增加：

```text
minChangedScore
minChangedRatio
```

规则：

- 首帧始终接受
- 已有帧后，`changed_score <= minChangedScore` 且
  `changed_ratio <= minChangedRatio` → `low_change`
- 低变化帧不进缓存，不替换 latest
- 计数进入 `frames_low_change` 和 summary/Host state

Host 的 `frames_low_change`、阈值也同步到 `state.observation`。

测试示例：阈值 `2 / 0.01`，首帧 0 接受，第二帧 1/0 丢弃，第三帧 3/0.2 接受。

## 复用 See Now

查看了 `third_party/sources/dsh-see-now-main/src`，保留未改，只 vendor 了三个无 ffmpeg 依赖的模块到
`plugins/dsh-assistant-host/vendor/see-now/`：

```text
cuts.js   64×36 RGB 网格 + HSV 三通道加权差
scale.js  cover 缩放，绝不改比例
png.js    纯 JS PNG 编码
```

附带上游 `LICENSE`、`NOTICE` 和本地归属说明。没有启动 See Now `startLoop`，没有引入 ffmpeg。

`frame-analysis.js` 使用这些模块：

- 64×36 HSV 变化分
- 变化格子的并集 bbox
- 按 bbox 裁出变化区域
- cover 缩放到 320×180
- `png.js` 编码缩略图

mss adapter 返回：

```text
changed_score
changed_ratio
change_bbox
thumbnail_ref
thumbnail_width / height
thumbnail_source_bbox
```

实测两帧：

```text
first:  score=0, first_frame=true, thumbnail=thumbs/thumb-frame-reuse2-1.png
second: score=1, ratio=0.0538, bbox=full screen,
        thumbnail=320×180
```

第二帧 bbox 覆盖全屏是因为多处零散变化连成并集；后续需要连通域/网格聚类收窄，
不能把“全屏 bbox”误当成真正变化区域。

## 变化区域聚类

`frame-analysis.js` 现在把 64×36 变化格做 **8 邻域连通区域**，按格子数/权重排序：

- `change_bbox` 取最大区域，不再取所有变化格并集
- `change_regions` 返回最多 5 个区域
- 缩略图只裁最大区域
- 全屏零散变化不会再直接变成整屏 bbox

真实两帧结果：

```text
second: score=1, ratio=0.0516
bbox={left:0, top:160, width:240, height:200, cells:15}
regions=5
```

第一区域从全屏缩到 240×200，缩略图为该区域。

### 小区域过滤

`FrameChangeAnalyzer` 默认 `minRegionCells=2`：

- 小于 2 个 64×36 格子的孤立区域不参与 bbox
- `filtered_regions` 记录被过滤数量
- 若没有足够大的区域，非首帧不生成缩略图
- 首帧仍生成整屏缩略图，作为初始证据

真实两帧：

```text
score=2, ratio=0.1923
bbox={left:1720, top:280, width:840, height:1160, cells:204}
regions=5, filtered_regions=5
```

### 缩略图缓存

mss adapter 每个 scope 的有界缩略图队列，默认 `maxThumbnails=8`：

- 新缩略图入队
- 超出后删除最旧 PNG
- 只保留最近窗口；ObservationService 默认 `maxFrames=8` 与之对齐

实测 `maxThumbnails=3`、连续 5 帧：

```text
thumb files=3
kept=frame-evict-2/3/4.png
```

注意：如果 Host 配置的帧缓存大于缩略图队列，旧 frame 的 `thumbnail_ref` 可能失效；
后续应把两者容量绑定，或在服务淘汰时通知 adapter。

## 窗口 geometry 与 WDA 实测

`mss-adapter.js` 对 `kind=window` 且带 `bounds` 的 scope 做几何校验：

- 使用 `--hwnd` 抓当前窗口
- 结果 `bounds` 与 scope bounds 比较
- 默认容差 2px
- 不一致抛 `geometry_changed`
- Host/runner 捕获失败会进入 observation fault

受控 Tk 窗口实测：

```text
初始物理 bounds = {left:480, top:330, width:804, height:629}
移动后实际     = {left:150, top:150, width:774, height:659}
adapter         → geometry_changed
```

这里也确认了一个重要坑：同一个窗口在非 DPI-aware 进程里读到的是
`{320,220,536,419}`（1.25x），而 mss/DPI-aware 进程读到的是
`{480,330,804,629}`（1.5x）。**scope.bounds 必须是物理、DPI-aware 坐标**，
否则会误判。

## compact UI 捕获排除

启动：

```text
node scripts/run_resident_ui_demo.mjs --exclude-capture
```

两个 compact 窗口：

```text
消息窗 WDA=0x11
输入窗 WDA=0x11
```

mss 抓整屏后，捕获帧中不存在 compact 助手窗口：

`results/vision/resident-capture-excluded.png`

注意：不带 `--exclude-capture` 时 WDA 为 `0x0`，助手 UI 会出现在捕获帧里；
这是预期行为，不是 bug。

## See Now 式唤醒调度

对照 See Now `loop.js` / `timer.js` 后，新增 `scene-wake.js`。它不采集、不调用
模型，只负责“什么时候值得叫醒一轮”：

- 插件侧 ticker，默认 2 秒一拍
- 只对新的 accepted frame 唤醒，同一帧不重复叫
- 自动唤醒最小间隔 8 秒
- 用户插话优先，冷却 3 秒
- 两帧等待期不重叠；onWake 正在跑时下一拍跳过
- onWake 失败重试一次；连续两轮失败就停
- 无用户且窗关超过 3 分钟 → idle stop
- 连续 8 次自动唤醒无用户响应 → idle stop
- 停止原因显式，timer unref

实测真实 mss + scheduler（静止屏幕，9.2 秒）：

```text
mss frames_seen=9
scheduler wakes=1
```

静止屏幕后续帧被低变化丢弃，service latest 不变，所以没有第二次唤醒；
这是期望行为，避免对没有新内容的画面刷模型轮次。

这与 See Now 的关键结构一致：**采集可以连续，叫醒必须有节奏、去重、可停。**

## 与 PreAct 的边界

调度器只产出 wake 事件（frame/用户插话），不执行鼠标键盘。

后续 PreAct 接入必须保持：

- 每次执行前有新的 action-ready 观察
- 必须有显式授权
- 单步执行，不自动重试
- 验证 passed 才算完成，failed/unknown 停止或重规划
- 旧坐标、旧观察不能复用

当前没有新增桌面输入。

## 指导步骤闭环

ResidentHost 新增可选 `stepVerifier`：

- `check_step` 先要求 ObservationService 有 5 秒内的新鲜 frame
- 没有 frame → 不推进，bubble 说明“没有新鲜画面”
- 调 `verify({task, step, frame})` 一次
- `passed` → 前进到下一步；最后一步 → `complete`
- `failed` → 保持当前步，不自动重试
- `unknown`/异常 → 保持当前步，不假装完成
- 未配置 verifier 时保留旧的 `checking` 状态

这让“提示一步 → 用户操作 → 检查 → 继续”的指导循环真正有状态，而不是
`check_step` 只把状态改成 checking。

## 调度器注入 Host

- `resume_observation` → scheduler.start
- `pause_observation` / `end_task` / `close` → scheduler.stop
- `chat_submit` → scheduler.noteUser，用户插话优先
- scheduler 自身仍然只产生 wake，不执行输入

## Wake 模型端口

新增 `wake-model-adapter.js`：

- `SceneWakeScheduler.onWake` → `WakeModelAdapter.handle`
- 输入只包含任务/步骤/帧元数据/缩略图引用，不包含真实模型客户端
- `should_speak=false` 时不发布消息
- 模型返回 `action_request` 时**只回传给调用方**，不执行
- 一个时段只允许一个 model turn，busy 时拒绝
- 默认 `OfflineWakeModel` 只生成确定性提示，不联网

真实 DSH 会话模型后续替换 `OfflineWakeModel`；当前没有网络调用。

端到端测试：

```text
ObservationService frame
  → SceneWakeScheduler wake
  → WakeModelAdapter
  → Host.publishAssistantMessage
  → task 仍停在 waiting_user
```

## PreAct 动作闸门

新增 `preact-gate.js`，把模型返回的 `action_request` 与真实执行隔开：

```text
action_request
  → 必须带新鲜 observation frame
  → 用户显式 grant（含 replay 动作和窗口范围）
  → 单次注入 replay
  → completed / failed / replan_required / unknown
```

边界：

- 未授权：不调用 replay
- 授权不覆盖窗口：不调用
- 证据超过 5 秒：不调用
- replay 失败：不重试、不换坐标
- `replan_required` 原样返回
- `unknown` 不当作成功
- 闸门自身没有鼠标/键盘驱动

真实 replay 后续接 `scripts/preact_replay.py`；当前测试只注入 fake replay。

## Action 请求桥

新增 `action-request-bridge.js`：

```text
模型 action_request
  → propose：发布“需要授权”，不执行
  → authorize：单独记录 grant，不执行
  → execute：一次 PreactGate replay
  → completed / failed / replan / unknown 发布结果
```

关键点：

- 授权和执行分离，不能在同一动作里偷偷完成
- 未授权 execute 直接返回 authorization_required
- 失败不重试
- 证据过期在 propose 前拒绝
- 桥自身没有输入驱动

测试：`tests/test_assistant_action_bridge.mjs` 4 项通过。

## 探索与录制

按新的产品方向，PreAct 没有现成程序时不再要求先有 program_id：

新增 `exploration-flow.js`：

```text
开始任务
  → 需要 exploration grant
  → 低风险步骤：连续执行
  → 高风险步骤：单独 risk grant
  → 每步必须验证 passed 才追加
  → finish 后整段序列 recordProgram 到 PreAct
```

边界：

- 没有 exploration grant 不能开始
- 高风险步骤未授权不执行
- 失败/unknown/replan 不追加、不自动重试
- 未 finish 不能录制
- 没有验证步骤不能录制
- 录制内容是长序列，不是单次点击
- 风险授权独立探索授权，不混用

测试：`tests/test_assistant_exploration_flow.mjs` 5 项通过。

## 录制转为 PreAct Draft

新增 `program-draft.js`：

- 将已验证探索步骤转换为 PreAct 形状
- 每步包含：
  - `target_label`
  - `visual_basis`（observation_id/image_sha256/capture_bounds/target_center）
  - `preconditions.window`
  - `action = {type:'click', target_label}`
  - `expected.description`
- `action` 禁止出现 center/screen_point/point/x/y
- 输出 `verification.status = "draft"`
- 只写 `runtime/program-drafts/`，不冒充 verified，不调用 `inventory.save_program`
- 不生成 proof

测试：`tests/test_assistant_program_draft.mjs` 3 项通过。

## Draft 重放与 proof

`scripts/preact_draft_verify.py` 已接入现有 PreAct 适配器：

```text
draft JSON
  → preflight 所有步骤/窗口/授权/视觉依据
  → ProgramReplayAdapter
      → 新观察
      → 重新定位
      → 固定执行器
      → B03/视觉验证
  → inventory.verify_program
      → 生成 verified record + content-bound proof
```

重要边界：

- 不自动 `inventory.save_program`
- 任何 preflight/replay/verify 失败都不产出 proof
- draft 的 `expected` 必须保留 template 等 B03 元数据
- 真实执行必须使用 Medium base Python
- 离线用 fake observe/locate/client/verify 跑过 `verify_program`：完成 replay 后确实生成 HMAC proof，且未创建 `runtime/programs`
- 失败验证不生成 proof
- 脚本本身不自动保存；保存是单独一步

测试：`tests/test_assistant_program_draft.mjs` 4 项通过（含 expected template 保留）。
离线 proof：`tests/test_preact_draft_proof.py` 2 项通过。

## Live draft replay、proof 与入库

2026-11-03 23:19，使用真实 Notepad：

```text
hwnd=2623642
title=test.txt - 记事本
draft=runtime/program-drafts/notepad-open-file-menu-v3-draft/v1.json
grant=95bff992-5913-4190-93e2-5da53e8a4e47
```

第一次运行在 `verify_draft()` 成功后，输出 JSON 时崩溃：`ProgramRecord` 不能直接
`json.dumps`。点击已经发生，但 proof 没有写盘。修复 `jsonable()` 和结果写盘后重跑。

最终结果：

```text
status=completed
clicks=1
input_events=3
task_success_verified=false (回执本身仍不冒充任务成功)
B03/proof verification=ok
```

证据：

```text
results/preact-draft/notepad-open-file-menu-v3-draft-20261103T151946Z.json
```

随后用 `inventory.save_program` 保存，并用 `load_program` + `verify_proof` 复核：

```text
runtime/programs/notepad-open-file-menu-v3-draft/v1.json
status=verified
proof=present
```

授权已撤销，当前无活动 grant。

## 多步 live 重放尝试（未通过）

同日用 `notepad-file-menu-toggle` 两步程序转 draft 后重放：

```text
draft=runtime/program-drafts/notepad-file-menu-toggle-draft/v1.json
grant=2858c049-bea0-405a-b318-93fda6b208b2
result=results/preact-draft/notepad-file-menu-toggle-draft-20261104T121834Z.json
```

结果：

```text
status=stopped
reason=EXPECTED_NOT_VERIFIED
step_id=2
verification.status=failed
similarity=0.937414 (< 0.98)
template=notepad-file-menu-closed-visible-v3.png
changed_ratio=0.062586
```

含义：

- 第一段流程把菜单打开
- 第二步点击已经送达
- 第二步“菜单已关闭”模板验证失败
- 整个程序没有 proof
- 没有保存新的多步 program

这是正确的拒绝：**输入送达不等于流程完成**。没有通过模板验证，就不能把两步程序标成 verified。

授权已撤销。下一步应修 closed 模板/区域或换一个两步目标，而不是降低 B03 阈值硬过。

## 模型端口与语音接口

新增：

```text
plugins/dsh-assistant-host/dsh-session-model.js
plugins/dsh-assistant-host/dsh-model-bridge.js
plugins/dsh-assistant-host/speech-bus.js
```

模型端口按 See Now 的方式复用 DSH：

```text
attachments.saveImage(frame thumbnail)
  → sessionController.resolveAgent(sessionId)
  → agent.followup({text + image})
  → session/event 中收集 assistant/message
  → 返回给 WakeModelAdapter
```

边界：

- 不直接调用外部 API
- 不执行动作
- 没有 assistant 文本时返回 `should_speak=false`
- 真实插件上下文尚未自动启动
- 图片 content 形状和实际 DSH 版本仍需现场验证

语音接口按 See Now `speech.js` 的事件模型预留：

```text
SpeechPort.speak()
  → emitSpeech({state:'due'})
  → 未来 TTS adapter onSpeech()
  → emitSpoken({state:'spoken'})
```

当前没有 TTS 引擎，也不自动播放；`Host.publishAssistantMessage` 已支持可选
`speechPort`，后续接适配器即可。

## DSH 模型探测命令

新增 `/assistant-model-check` 和 `/assistant-model-status`：

```text
命令
  → 抓一帧
  → attachments.saveImage(thumbnail)
  → sessionController.resolveAgent(current session)
  → agent.followup({text, image})
  → 命令立即返回
  → session/event 收到 assistant/message 后落 last.json
  → /assistant-model-status 读取
```

关键点：

- 不在命令内同步等待自己的模型回合，避免回合互锁
- 一次只允许一个 pending 请求
- 不接受命令附带文字/文件
- 不执行鼠标键盘
- 没有自动截图；只有显式命令才抓一帧
- 结果落在 `runtime/assistant-model/last.json`

测试：`tests/test_assistant_model_check.mjs` 3 项通过。

显式实时观察命令 `/assistant-model-watch` 已把 mss ObservationService、SceneWakeScheduler
和模型探测接在一起：每 2 秒抓帧，SceneWake 限速后只把 accepted frame 异步交给当前
DSH 会话模型；`/assistant-model-stop` 停止。测试：`tests/test_assistant_model_watch.mjs`
1 项通过。

**用户现场实测（2026-11-04 21:37–21:38）**：`/assistant-model-check` 成功收到模型对
截图的描述；`/assistant-model-watch` 产生多次观察回复。确认当前 DSH 会话能接收图片
并回答问题。该次实测使用的是自然语言回复；结构化 `speak` 协议是随后加入的，尚未
现场复测。

**面板启动**：新增 `/assistant-open` / `/assistant-close` 和 `PanelSession`。测试用
`PanelSession` 直接启动 compact Tk 面板并关闭，ui_pid 出现、关闭后无残留。命令本身
需要重新加载插件后才会出现在 DSH。

**结构化输出**：`ModelCheck` 现在要求模型返回：

```json
{"speak": true, "text": "...", "reason": "..."}
```

- 只有 `speak=true` 才写面板/触发 speech
- `speak=false` 静默
- 非 JSON 回复按 `unstructured_reply` 静默，不猜
- `tests/test_assistant_model_check.mjs` 4 项通过

**尚未完成**：重新加载插件后现场验证 `/assistant-open` 和结构化 JSON 输出；TTS 未接。

## 面板重复打开故障修复

现场错误：

```text
assistant-open: state_revision must not decrease
assistant-open: assistant instance already running: pid=1884
assistant-close: 助手面板已关闭
assistant-open: assistant instance already running: pid=1884
```

原因：

- `PanelSession.open()` 把 `host.initialize()` 放在 try 外
- 旧 state revision 较高，新 Host 从 0 写入失败
- 失败后没有 close，`instance.lock` 和 `state.json` 留下
- `/assistant-close` 是新的 PanelSession 对象，关不到旧 Host

修复：

- open 前清理 stale `instance.lock/state.json/ui-ready`
- 同进程旧 UI 进程先停止
- 只有 lock 属于其他活进程才拒绝
- `host.initialize()` 包进 try，失败也执行 close
- close 读取 `ui-ready.json`，即使对象丢失也能停 UI 并移除 lock

清理后复测：

```text
PanelSession open: ui_pid=26100, ui_alive=true
PanelSession close: ui_alive=false, no residual
```

当前 `runtime/assistant-panel` 已清理掉陈旧 lock/state。

## 成本门控

用户指出：`speak=false` 只是输出静默，模型调用仍然花 token。确实如此。新增：

```text
plugins/dsh-assistant-host/candidate-gate.js
```

`/assistant-model-watch` 现在：

```text
mss 2s
  → ObservationService
  → CandidateGate（模型前）
      变化分 < 2 且变化比例 < 0.01 → 不调模型
      变化区域 < 画面 0.1% → 不调模型
      扫描间隔冷却（默认 8s，可用 /assistant-model-watch 5 改）
      强变化（分 >=32 或比例 >=0.12）视为新场景，重置退避
  → SceneWake
  → 模型
  → speak=false
      → 退避 16s/32s/...，不自动停止
  → speak=true
      → 重置静默退避
```

说明：

- 观察循环常驻，只有用户 `/assistant-model-stop`、关闭面板或真实错误才停
- `maxAutonomousWakes = Infinity`，不再 8 次自动结束
- `maxModelCalls = 0` 默认不硬停；配置预算时只是暂停模型调用，继续观察
- 模型 pending 视为跳过，不当作 wake failure
- `speak=false` 仍然是一次模型调用；本地门控负责尽量不送无意义帧
- 静默只降频，不再自动停

测试：candidate-gate 4 项、watch 2 项通过。

仍未做：独立 worker 短上下文；当前自动调用仍进用户主会话，所以上下文会增长，
而且模型原始 JSON 仍可能出现在主聊天。

## 主动性 / 新画面语义

原 prompt 问“是否值得提醒”，会把所有内容都判成“不需要提醒”。现改为角色提示：

```text
你是常驻桌面角色（默认鲸鱼助手）
new_scene=true：主动按角色口吻评论/观察/提问
new_scene=false：只有新信息才说话，否则沉默
```

`CandidateGate` 的强变化帧会带 `new_scene=true` 给模型。  
`characterCard` 已作为 `ModelCheck` / `ModelWatch` 参数预留，后续接角色卡配置。

## 面板菜单闪烁

原生 `tk_popup` 在 overrideredirect + topmost 面板上会因 grab/按钮释放竞争闪烁。
已替换为自定义 `CompactMenu`：

- 普通 Toplevel，无 native popup/grab
- 点击面板或菜单项关闭
- 菜单窗口也加入 WDA 捕获排除
- “暂停/恢复观察”标签改为 `set_label`

Python Compact 测试 4 项、layout 4 项通过。

## 面板不可见：WDA 排除

重启后 `/assistant-open` 返回成功、Python UI 进程和 Tk 窗口都存在，但用户看不到。
现场检查：

```text
ui_pid=29196
TkTopLevel "鲸鱼助手 · 输入"
rect 1972,1312 560x64
visible=true
exstyle=0x00080088 (LAYERED|TOOLWINDOW|TOPMOST)
alpha=250, region=373x43
```

诊断：用同样的 `PanelSession` 启动一个**不带 `--exclude-capture`** 的临时面板，
`desktop_observe` 能看到输入框、发送按钮和消息气泡。差别只有 WDA。

结论：`WDA_EXCLUDEFROMCAPTURE` 在该 Windows/NVIDIA 环境下不仅影响截图，
还让面板对用户不可见。`/assistant-open` 的 `PanelSession` 现已默认
`excludeCapture=false`。

代价：模型观察会把面板自身拍进画面；后续需要观察区域遮罩，而不是重新用
WDA 把面板隐藏。

## 面板输入接入模型

新增：

```text
plugins/dsh-assistant-host/panel-model.js
```

链路：

```text
compact 输入
  → ResidentHost chat_submit
  → PanelChatModel
  → DshSessionModel.followup(kind="chat")
  → 当前 DSH session/event
  → assistant 文本
  → 面板气泡 + Host 消息
```

限制：

- 当前绑定的是**用户主会话**，所以面板输入会出现在主聊天
- 角色卡和独立 worker 还没接
- 模型回复超时/为空时明确显示失败，不伪造离线回复

测试：`tests/test_assistant_panel_model.mjs` 2 项通过。

## 测试

```text
node --test tests/test_assistant_speech.mjs
4 passed
```

```text
node --test tests/test_assistant_dsh_session_model.mjs
3 passed
```

```text
node --test tests/test_assistant_dsh_bridge.mjs
2 passed
```

```text
node --test tests/test_assistant_model_check.mjs
4 passed
```

```text
node --test tests/test_assistant_model_watch.mjs
2 passed
```

```text
node --test tests/test_assistant_candidate_gate.mjs
4 passed
```

```text
node --test tests/test_assistant_panel_model.mjs
5 passed
```

```text
node --test tests/test_assistant_panel_guidance.mjs
3 passed
```

```text
node --test tests/test_assistant_highlight.mjs
4 passed
```

```text
node --test tests/test_assistant_step_loop.mjs
6 passed
```

```text
node --test tests/test_assistant_wake_model.mjs
6 passed
```

```text
node --test tests/test_assistant_preact_gate.mjs
5 passed
```

```text
node --test tests/test_assistant_action_bridge.mjs
4 passed
```

```text
node --test tests/test_assistant_exploration_flow.mjs
5 passed
```

```text
node --test tests/test_assistant_program_draft.mjs
4 passed
```

```text
PYTHONPATH=src;. <base-python> -m unittest tests.test_preact_draft_proof
2 passed
```


## 已验证

- start 后状态 running，pushFrame 接受当前帧
- latest 返回最新帧
- after / scope_id / geometry_revision 过滤
- 过期帧返回 stale
- 错误 scope/geometry、非法 changed_score 拒绝
- pause 清空待发帧并拒绝新帧
- resume 后重新接受新帧
- maxFrames 有界，latest 仍为最新
- stop 清空 scope/frame
- fault 状态显式记录原因
- summary 计数和 latest id

## See Now 边界

`see-now-adapter.js` 明确报告：

```text
available: false
reason: ffmpeg-unavailable
start().ok: false
```

本机未发现 ffmpeg，因此没有启动上游采集链，也没有伪造真实截图。这是有意的
RH04 阻塞，不是测试遗漏。

- Host `resume_observation` 注入 service + 单帧采集
- Host `pause_observation` 清空 latest
- Host 采集失败进入 observation fault，不推进任务
- 真实 Host + mss：resume 后 `frames_seen=1`，latest frame id 写入 state

## 高亮指导

已接上只读高亮第一版：

```text
PanelChatModel
  → 指导回复末尾 [[HIGHLIGHT:目标文字]]
  → ResidentHost.highlightResolver
  → highlight_locator.py（Windows OCR）
  → CoachOverlay 状态文件
  → 透明、点击穿透的矩形框
```

补充：模型没有当前画面，之前输入“教我点击‘新会话’”会反问“屏幕上能看到吗”。
现在 `PanelChatModel` 先从用户句子里本地推断目标：

```text
教我点击“新会话” → 新会话
教我打开文件菜单 → 文件菜单
```

目标明确时，prompt 禁止反问并要求输出 HIGHLIGHT；如果模型仍然输出“请先告诉我在哪个界面”，
会回退成“请点击屏幕上的‘新会话’”，同时继续走 OCR 高亮。目标不明确时不伪造高亮。

### 指导闭环

面板模型返回 `highlightTarget` 后，Host 会自动建立一个单步指导任务并高亮目标。
用户在面板点“检查当前步骤”时：

```text
新 mss 截图
  → 独立 verifier 模型请求（带当前图）
  → 只接受 JSON {status: passed|failed|unknown}
  → passed：清除高亮，完成任务/进入下一步
  → failed/unknown：保留当前步骤，不推进
```

`PanelStepVerifier` 在没有 ObservationService 时可以用 `captureFrame` 自行取得新帧；
非 JSON 回复按 `unknown` 处理，不把“用户说完成了”当成功。

同时提供手动验证命令：

```text
/assistant-highlight 新会话
/assistant-highlight-clear
```

边界：

- 只显示，不点击、不输入
- 目标找不到时明确失败，不显示旧框
- 任务结束、暂停观察、跳过步骤、关闭面板都会清除高亮
- 面板关闭会停止 Overlay 子进程
- 高亮框本身不进入验证结论

实测：

```text
OCR 定位“新会话” -> rect [474,251,112,40]
PanelSession + Overlay 端到端显示矩形和箭头
```

限制：

- 目前高亮层默认不做 WDA 排除，模型观察会把它拍进去；需要观察遮罩
- 目标定位依赖 Windows OCR；图标/无文字目标暂不支持
- 还没有和 `check_step` 验证结果自动换高亮

## 测试

```text
node --test tests/test_assistant_observation.mjs
8 passed

node --test tests/test_assistant_observation_host.mjs
4 passed

node --test tests/test_assistant_observation_runner.mjs
3 passed

node --test tests/test_assistant_frame_analysis.mjs
6 passed

node --test tests/test_assistant_scene_wake.mjs
5 passed

E:\python\python.exe -B -m unittest tests.test_capture_score
4 passed

真实 mss 连续 loop：3 frames / 1.6s
真实 mss 两帧变化分：first=0, second=1
真实 mss 缩略图：320×180 PNG
```

测试使用合成帧、固定时钟和 fake capture；真实 mss 只做受控单帧/短 loop，
没有 API、模型或桌面输入。

## 尚未完成

- SceneWakeScheduler 还没注入 ResidentHost/compact UI
- 相邻区域合并策略（当前只做连通域 + 小区域过滤）
- 缩略图容量与 ObservationService 帧缓存容量未强绑定
- 未做多屏混合 DPI 验证
- 未接真实模型/PreAct 执行
- 未做 Coach 当前步骤验证

## 下一步

1. 把 scheduler 注入 Host/compact：用户插话优先、wake 后发消息给模型适配层
2. 用 PreAct 的授权/验证 gate 接 wake 后的动作建议
3. 做真实“看视频 8 秒级提示”端到端小样
4. 再接 RH05 模型通道
