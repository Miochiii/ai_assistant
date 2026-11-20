# 输入链路代码审查修复与 DeepSeek 交接

日期：2026-11-01。工作目录：`E:\file\agent\ai assistant`。

用户授权：修复上一轮列出的 7 项问题，并整理修改说明。本轮修改源码和离线测试；没有控制真实桌面，没有调用模型 API，没有安装依赖，没有修改 RAG 环境。

## 1. 先读结论

执行器版本由 **0.5.0 升为 0.5.1**。动作请求 schema 没有变更，但释放状态、输入失败回执、焦点接收器要求和会话校验发生了变化。

七项问题均已作代码处理，其中拖拽采取了**缺少可靠监测则禁用生产入口**的处理方式，不能解读为完整拖拽能力已经交付。坐标转换及逐段检查代码保留，测试通过 fake backend 验证；真实 `Win32Desktop` 尚无可信实时干扰监测器，返回 `DRAG_MONITOR_UNAVAILABLE`，发生在移动鼠标之前。

最终离线结果：**94 项 Python 测试、24 项 Node 测试通过**，两处 JS 语法检查通过。它们证明指定回归路径，不代表真实应用送达或任务成功已经验收。

## 2. 七项问题与修改

| 问题 | 修改 | 当前边界 |
| --- | --- | --- |
| 拖拽将图像相对坐标当作屏幕坐标 | 起点使用已有 `target_screen_point`；终点加 `capture_bounds.left/top`；路径采样和底层 drag 使用同一屏幕坐标系 | 不直接使用模型附件缩放坐标；生产拖拽仍禁用 |
| 部分输入后取消，被记作零输入和 pre_action | 新增 `_sync_input_trace`，在拒绝和 finally 路径汇总已接收事件；异常保留 `unknown_after_input`；operation journal 落 `unknown` | 禁止因此重试原动作；已接收事件不是应用处理证明 |
| 键盘/组合键/文本释放状态漏记、误称已观察中立 | `_release_state` 覆盖 key/chord/text；释放失败保留 `pending_or_possible_down`；API 确认标为 `api_release_accepted` | 不再把 SendInput 返回值叫作 `observed_neutral`；仍无独立硬终止恢复监督器 |
| 同 HWND 下菜单/捕获变化、未知输入接收器可通过 | 校验完整 focus evidence、菜单和鼠标捕获；文本增加接收器能力与状态检查 | 仅开放标准 Win32 `Edit` 控件；密码、只读、有选区或未知接收器拒绝 |
| 拖拽期间只看前台、取消，缺少抢占监测 | 生产入口要求可信 `check_drag_interference`；逐段复核窗口身份、几何版本、剩余路径遮挡和捕获 | 没有提供假监测器；此项以 fail-closed 修复，待独立实现监测后才能重新开放 |
| 固定执行器缺少 Harness 会话授权核对 | 宿主把实际 session ID 经启动环境传入；执行器核对 grant 的 `harness_session`；Python ActionClient 和 PreAct 同步传递 | 对有会话绑定的 grant，缺失或不匹配都拒绝；保留原有无会话绑定 grant 的兼容行为 |
| UTF-16 分批可能切开代理对 | 在 8 个 UTF-16 unit 的分批边界避开 high/low surrogate 中间位置 | `1234567😀x` 已覆盖；不扩大现有短文本额度或控制字符许可 |

同时修正了 `press_key` 成功返回时多计 1 个事件的问题，以及拖拽初始移动失败时硬加 1 个事件的问题。拖拽正常 mouse-up 失败会进入 finally 进行 release-only 清理，不重新发送拖拽业务动作。

## 3. 具体文件

以下路径相对本项目根目录，供 DeepSeek 定位：

| 文件 | 变化 |
| --- | --- |
| `src/desktop_adapter/executor.py` | 焦点/接收器校验，事件汇总，释放状态，Harness 会话校验，拖拽坐标与禁用门禁，逐段路径复核 |
| `src/desktop_adapter/single_click.py` | 标准 Edit 元数据读取、拖拽途中路径检查、释放清理、键事件计数、UTF-16 分批及文本批次按键检查 |
| `src/desktop_adapter/action_contract.py` | `EXECUTOR_VERSION = "0.5.1"` |
| `src/desktop_adapter/action_client.py` | 增加 `harness_session` 参数，通过子进程环境传递 `DSH_SESSION_ID` |
| `scripts/preact_adapter.py` | 创建默认 ActionClient 时传入宿主会话 |
| `scripts/run_desktop_executor.mjs` | `runExecutor` 接收宿主 `harnessSession`，将其传入子进程；缺失时使用空值，不继承其他会话 |
| `plugins/dsh-desktop-observe/action.js` | click/scroll/key/text/chord/drag 六个工具均向 runner 传入当前宿主会话 |
| `tests/test_input_review_regressions.py` | 新增 13 项离线回归测试，全部使用假桌面/假子进程，不注入真实输入 |
| `tests/test_executor.py` | 更新接收器证据、释放状态和 fake backend；fake drag monitor 仅用于测试 |
| `tests/test_preact_adapter.py` | 测试夹具使用当前执行器版本常量，不再硬编码 0.5.0 |
| `tests/test_desktop_action.mjs` | 增加会话传递断言；测试授权改用随机 ID 并清理，避免覆盖已有同名授权文件 |

## 4. 回执与授权语义

### 4.1 失败回执

- `input_events_sent` 表示底层接口报告接收的事件数，包含补偿释放事件；不是文字已插入或业务操作已完成的证明。
- 发生部分输入后，即使随后取消，也不能抹去已接收事件。回执是 `unknown_after_input`，journal 是 `unknown`，不得自动重放同一业务动作。
- `pending_or_possible_down = true` 时停止后续业务输入；不能用重新发送整段动作来“补齐”。
- `api_release_accepted` 只表示 API 接收了完整配对输入或释放清理；不证明接收应用完成，也不证明物理设备无按键按下。
- 本轮没有解决进程被强制 kill、系统退出等导致 finally 无法运行的全部问题。禁止在后续文档中承诺“任何取消都绝不遗留按下”。

### 4.2 文本输入

`focus_info` 只读取控件类名、样式、窗口矩形、选区是否折叠等元数据，不读取文本正文。标准 `Edit` 的选区用有超时的 `EM_GETSEL` 获取；异常或超时视为不支持。

需要观察时和执行时两份有效的 `text_receiver`，以及一致的控件 HWND、类名和矩形。旧 observation 缺少这些字段时必须重新观察。

这是按控件能力作限制，不是按“记事本/计算器”等应用名做专用适配。RichEdit、浏览器输入框、自绘编辑器、终端、复杂 IME 场景未在本轮获得支持；即使看起来像输入框，也不允许放宽为“只要焦点一致就输入”。

当前检查不能证明批次之间用户未在同一控件内移动光标，也不是完整的物理输入监测器。文本仍限制为既有短片段；长文本/复杂组合键等能力不能借此扩展。

### 4.3 会话边界

会话值来自宿主执行上下文，不来自模型 action JSON。链路为：

```text
Harness tool execution session
  -> runner options.harnessSession
  -> child env DSH_SESSION_ID
  -> executor compares authorization.harness_session

PreAct adapter harness_session
  -> ActionClient.harness_session
  -> child env DSH_SESSION_ID
```

有会话绑定的 grant 在缺少/不匹配 session 时返回 `AUTHORIZATION_SESSION_MISMATCH`。既有 Windows 登录会话、窗口和动作权限校验继续生效。

这个比较不是密码学身份认证，也不能抵抗一个可随意修改工作区代码、授权文件或启动环境的本地进程。无会话绑定的 legacy grant 仍按原规则处理，本次没有自动废止或改写用户授权。

## 5. 测试记录与限制

Python 最终运行以下模块，共 94 项，0 failure、0 error：

```text
test_input_review_regressions
test_single_click
test_executor
test_action_contract
test_operation_journal
test_inventory
test_action_client
test_action_client_cancel
test_preact_adapter
test_preact_replay_memory
```

使用现有基础 Python 3.14 解释器 `-B`，显式引入项目 `.venv` 的依赖目录；未安装任何新包。由于当前受限 Windows 执行环境与 Python TemporaryDirectory 的权限行为不兼容，测试运行器仅在自身进程内将 `tempfile.mkdtemp` 替换为项目 `tmp/review-<uuid>` 下的普通 mkdir；未修改生产 tempfile 逻辑，结束检查子目录剩余数为 0，并移除本轮目录。

Node 命令及结果：

```powershell
node --test --test-isolation=none tests/test_desktop_action.mjs tests/test_authorization.mjs
# 24 passed, 0 failed
node --check scripts/run_desktop_executor.mjs
node --check plugins/dsh-desktop-observe/action.js
# 均通过
```

默认 Node test 隔离模式曾因受限环境 `spawn EPERM` 无法启动，改为不启用子进程隔离后完成。测试中没有启动真实动作执行器；取消测试使用合成脚本/假 runner。

首次版本升级后，8 项 PreAct 测试因夹具硬编码旧版而触发 `EXECUTOR_VERSION_CHANGED`；改用版本常量后通过。没有修改真实程序库来绕过版本门禁。此前发现的 fake key release 重复计数也已修正；以上最终数字来自修正后的完整定向回归。

## 6. DeepSeek 下一步怎么接

1. 先阅读本文件。不要把生产拖拽的禁用门禁改成空函数来恢复表面成功；测试 fake monitor 不是生产实现。
2. 插件源码已修改；运行中的 Harness 可能缓存旧模块。下次安排工具验收前完整重启 Harness，并核对加载的是本项目链接。此次没有替用户重启或重新安装。
3. **旧 0.5.0 PreAct 程序会因执行器版本变化被拒绝。** 通过重新观察和实际验证生成新版本/新 proof；不能只修改 JSON 的版本号或复制旧签名来通关。
4. 使用全新 observation、当前会话 grant，在用户选定的非重要测试文档里逐项验收短文本、有限导航键和滚动。旧 observation 无接收器证据被拒绝属于预期。
5. 拖拽重新开放需单独完成：可信输入来源标记、物理抢占检测及健康检查、失效即停、独立释放监督，以及 DPI/多显示器/遮挡/窗口改变测试。现有 `check_drag_interference` 只是后端接入约束，不是监测已实现。
6. 本轮不扩展到任意快捷键、批量文本、剪贴板、提交/发送操作，不启动第二条 grounding 模型线。保持通用动作协议和授权边界，用户特定流程继续由 PreAct 承载。

## 7. 用户手动删除的上一轮 Temp 目录

位置：`C:\Users\Mio\AppData\Local\Temp`。以下 42 个目录来自上一轮测试，创建时间为 **2026-11-01 22:03:10–22:03:11**。此前工具删除时访问被拒绝；本轮没有改其权限或继续删除。用户可核对名称和时间后手动删除，**不要清空整个系统 Temp，也不要批量删除所有 tmp 前缀目录**。

```text
tmpl6zp6dy8
tmp4e4imupd
tmpc6u1k4rv
tmpt_8dtgsk
tmpt7_og74m
tmpb1w0qols
tmprpu8hzne
tmp3tphzp7b
tmptaflxs_u
tmp0n8ay8nf
tmprqr7lwee
tmp32xk3gj2
tmpl4r6h8zs
tmp1ofe7ncz
tmp0v7d2bpk
tmpuou4u13v
tmpt1rwm6j6
tmp3mqq_9du
tmpad98ykn0
tmpw4wkyzrg
tmpo_4h_nyy
tmpxmsagzl4
tmp1yjpkyh2
tmpd6pfk6p9
tmp1gy_2xc6
tmpoh2oostn
tmpg5xp6pit
tmpiu85ezxt
tmp5c1hd0y9
tmp827kk_2g
tmpgvkx59z9
tmpufye8oom
tmpidgjop0o
tmp7_5eaaq_
tmp1xv2szzn
tmp5qrc8qx3
tmp885pdh2_
tmp_ztwt4w_
tmpqwdtt1o5
tmpp_ix_tny
tmp53rzqqyn
tmpk7f_sbs7
```

项目 `E:\file\agent\ai assistant\tmp` 是另一个目录。它现有的 `pdfs`、`inspect_context_state.py`、`repair_context_state.py` 不属于本轮临时文件，没有删除。本轮新增的测试目录和测试授权已清理；原有两个授权文件保留。
