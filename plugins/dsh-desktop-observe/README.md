# Harness 桌面观测与单次动作插件

本项目的本地适配层，版本 0.6.5，无 npm 运行时依赖。复用项目 Python 环境中的 MSS 10.2.0 和 Harness 自带附件服务；观测不做应用专用分支，动作固定为一个受限左键点击执行器，另有一个只做前台切换的置前工具。0.6.5 另通过包内 `memory-host` 行接入记忆核心：四个只读/候选工具和人类 `/memory` 命令，不把记忆 CLI 暴露给模型。单步点击和 PreAct 重放都接运行记录；固定执行器在输入前获取跨进程桌面输入租约。`desktop_replay` 接受最多 8 步已验证程序；0.6.5 接入 W1/W2 窗口区、记忆自动化第一批；`desktop_click` 和 `desktop_replay` 的自动 checkpoint 已 live 验收，自动检索仍关闭。

隔离会话自检请在加载 0.6.5 后输入 `/desktop-offline`，从候选列表点击执行，不附参数；候选没有出现时不要发送普通聊天。旧版本 `/desktop-trial offline` 缺少客户端参数声明，会落入普通聊天，已修复。离线检查无需批准在线预算。见 [受限入口说明](../../docs/restricted_session_entry.md)。

记忆接入说明见 [memory_host_integration.md](../../docs/memory_host_integration.md)：模型只有 `memory_recall`/`memory_propose`/`memory_checkpoint`/`memory_resume`，显式写入、确认和删除走 `/memory`。`/memory help` 和两会话命令已实际成功；新空会话的 command result 行可见性仍未查清。运行记录见 [run_ledger.md](../../docs/run_ledger.md)。视觉 P0/P1 计时与变化检测见 [vision_efficiency.md](../../docs/vision_efficiency.md)；默认 off，不改变点击行为。

## 宿主本地自检

0.3.0 新增 `/desktop-check` 命令，依赖宿主 `commands` 服务。完全退出并重启 Harness 后，在本项目工作目录的会话中输入 `/desktop-check`，先确认命令候选出现，再选中执行；若候选没有出现，先检查插件加载，不把这段文字作为普通聊天提交。

命令通过宿主 `CommandRuntime` → `ToolRuntime.execute` → `desktop_monitors` 读取显示器，只返回本地检查结果，不向 agent 追加消息，不截图、不上传、不输入。会话保留 command/run、command/done，项目回执保存到 `results/host-check/<uuid>.json`。目前只是连接检查，不能当成模型选择工具、视觉识别或完整操作循环通过。

保留宿主的可见性、权限和调度规则；拒绝、取消及空显示器结果均不记为通过。如果当前会话采用 PTC 模式、不能直接调度该工具，回执标明此限制，不绕过宿主策略调用工具函数。2026-10-24 已通过实际宿主连接检查，证据 `results/host-check/c7b06c54-648e-49cd-afee-dd606fc6f90d.json`：一个 2560×1440 显示器，native 调度。

0.3.0 的现场问题是执行成功但用户看不到返回，具体时间线显示问题尚未确认。0.3.1 增加客户端结果提示：收到 `command/executed` 后，在对应会话的输入框通知区显示本命令结果，不依赖聊天时间线是否已经显示。新提示需要重启加载，并仍待现场确认；既有连接通过的证据不受影响。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `desktop_monitors` | `{}` | 显示器编号及物理像素边界 |
| `desktop_windows` | `{}` | 可见顶层窗口的 hwnd、pid、class、title、物理 rect；只读 |
| `desktop_activate` | `hwnd` | 只做前台切换：检查自身/目标完整性、同 session、`WinSta0\Default`，拒绝 elevated 目标，恢复最小化并回读前台；不点击、不输入 |
| `desktop_observe` | `monitor`（默认 1）；可选 `region`；`hwnd`（来自 `desktop_windows`）；`include_image`（默认 false） | 本地 PNG 元数据；带 `hwnd` 时另写窗口绑定和 RGB 基线，成为 action-ready 观察；显式启用图片时另附原生图片块 |
| `desktop_click` | `observation`（action-ready 观察路径）、`label`、`center`（附件像素）、可选 `coordinate_space`/`expected` | 固定执行器回执、动作后观察路径、通用 `post_action_delta`；启用图片时附动作后截图 |

只接受会话工作目录为 `E:\file\agent\ai assistant` 的调用。启动插件不会截图；`desktop_windows`/`desktop_observe` 不输入。`desktop_click` 只调用固定执行器，一次观察最多一次点击，不自动重试；`task_success_verified` 始终由外部验证决定。图片内容块交给宿主后可能在后续模型请求中上传，不能将“只读工具”理解为不会外发图片。插件自身保持 `recognition_status=not_run`，截图不能作为任务成功的证明。

## 动作链路（0.5.1）

1. `desktop_windows` 取目标窗口的 `hwnd` 和 rect。
2. 目标不在前台时调用 `desktop_activate`；它只切换前台并回读确认，不发送鼠标键盘按键。
3. `desktop_observe` 传 `hwnd`（可选 `region`，缺省为整窗），创建带 `click-binding.json` 和 `source.rgb` 的 action-ready 观察；`include_image=true` 时返回附件。目标窗口必须在前台；被覆盖时在截图前拒绝。
4. 模型在附件像素中给出 `center`，调用 `desktop_click`；执行器用观察 ID、图片尺寸、桌面原点自行映射，重新检查时间、窗口、前台、输入、画面和指针移动。
5. 执行器返回动作后观察与 `post_action_delta`；启用图片时工具附带动作后截图。输入送达不等于任务成功，模型/用户仍需核对预期结果。
6. 取消信号会传到执行器；输入前/按键前检查取消文件，取消后等待进程退出。无法确认是否执行时返回 `cancelled_unknown`，不自动重试；动作后异常保留真实点击/事件计数。
7. 程序库存只接受带内容绑定 proof 的重跑验证记录；外部输入默认只能建草稿，状态不匹配即停止重放或重新规划。
8. 任务授权贯穿 activate/observe/click/replay：没有覆盖目标窗口和动作的有效授权时拒绝；窗口越界需用户用 `scripts/authorize_task.py` 重新授权。授权文件是本地事故边界，不是签名。
9. 普通截图/RGB 短期保留，程序视觉依据/模板长期保留；`scripts/cleanup_evidence.py` 默认 dry-run，只删项目证据和索引内 Harness 附件副本。
10. PreAct 目标定位已改为限定邻域补丁搜索（半径 64/stride 4），返回新中心；not_found/ambiguous 停止，不固定复用旧坐标。
11. 多步程序每步 preflight 自己的窗口/授权/依据/区域，全部通过才开始动作；每步重新 observe/locate/verify，中途失败停止且不回滚已完成步骤。
12. B03 支持可选 `critical_region`：关键文字区域的小改动会让整个验证 failed，区域外的小改动不会误报；这是通用视觉参数，不写应用专用逻辑。

**当前 `image_attachment_enabled` 为 true（用户 2026-10-25 授权长期开放）**，图片会随当前模型请求产生输入 token；不再逐次授权。**重启后新插件已加载**：`desktop_windows` 返回 `authorization_grants`；现场 `desktop_activate` → `desktop_observe([60,88,400,300])` → `desktop_click` 通过，回执含 grant_id，B03 0.994526；无授权窗口被拒绝。PreAct v2 先因 hover 背景 `TARGET_NOT_FOUND`，加 `edge_iou` 回退后完成（edge 0.9376，B03 0.994526）。

## 图片通道及当前开关

`configs/desktop-observe.json` 中 `image_attachment_enabled` 当前为 **true**（用户 2026-10-25 授权长期开放）。请求 `include_image=true` 时先检查开关，再检查当前会话路由支持 image，最后截图、校验哈希、保存附件并返回图片。纯文本路由仍会在截图前拒绝；开关只控制此工具的图片返回，不是全局预算或其他工具的权限控制。

图片会随 Harness 当前模型请求产生输入 token，费用仍归当前路由，不需要另外申请 API 密钥；不再逐次请求授权。若需要暂停成本，将开关改回 false 即可，动作执行本身不依赖图片返回。

图片保存可能缩放：`model_image.attachment` 包含模型附件的实际宽高，`model_image.coordinates` 指定附件像素坐标及映射到原桌面的比例和原点。采用左闭右开边界；拒绝越界或非有限坐标。`pointToDesktop` 只做几何换算，不操作桌面。原图元数据与哈希保留，不能用原图尺寸替代附件尺寸。

图片准备记录为同一截图目录中的 `model-image.json`，状态 `prepared_for_tool_result`，不代表供应商收到图片或识别正确。实际推理/识别评价须由后续模型事件另行记录。

PNG 和事件写入 `results/vision/<run_id>/`；截图证据在返回前进行哈希校验。每次截图必须根据当前显示器和画面确定范围，不可把示例裁剪坐标复用于变化后的桌面。

## 已执行的安装

使用 DSH 0.2.1-rc.2 自带 CLI 离线安装本地链接：

```powershell
& 'E:\dsh\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add --offline --ignore-scripts 'link:E:/file/agent/ai assistant/plugins/dsh-desktop-observe'
```

profile 同时声明该 bundle。原文件备份在 `runtime/backups/desktop-observe-20261023/`；原 RAG 链接及 `cordis.patch.yml` 保留。用户曾确认 0.1.0 全局插件可见。通过已有链接更新到 0.2.0 源码，无需重装依赖；用户已报告再次重启，尚未验证运行中会话对 0.2.0 的工具调用。

## 验证及边界

- 完整会话循环的离线验证见 `docs/agent_loop_validation.md`：复用真实 AgentLoop 和附件服务，模型及截屏为夹具，5 个集成案例通过。`request-limit.js` 目前未挂入插件入口；逻辑请求限制不等于供应商费用限制。
- `tests/test_desktop_observe.mjs`：参数拒绝、证据路径、会话目录约束、工具集合及注册失败回滚，5 项通过。
- `scripts/check_dsh_observe.mjs`：通过 Electron 的 ASAR 支持，读取本机 DSH 的工具库执行契约和真实注册器检查；提示词服务为空桩，不能代替运行中宿主验收。
- `results/a04/dsh-observe-smoke.json`：Node→Python 的真实截图桥接结果，不是由聊天模型触发的工具调用。
- `results/a04/dsh-observe-contract.json`：原生注册/卸载结果，明确 `running_desktop_host_tested=false`。
- `tests/test_image_delivery.mjs`：9 项图片通道检查；与原有 5 项插件测试合计 14 项通过。
- `scripts/check_dsh_image_delivery.mjs`：使用已有现场 PNG 和本机真实附件服务，在项目临时目录测试保存、读取、图片块、哈希拒绝和坐标换算。1245×1093 原图实际归一化为 301×264，中心正确映射为桌面 `(812,781)`；此为特意收紧测试尺寸，非正式识别配置。
- `results/a04/dsh-image-delivery-offline.json`：上述真实附件检查结果。临时附件库在 finally 中验证路径后清理；无新截图、无 provider 请求，不写用户全局附件库。

运行 Node 测试：

```powershell
& 'C:\Users\Mio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --test --test-isolation=none tests\test_desktop_observe.mjs tests\test_image_delivery.mjs tests\test_desktop_action.mjs tests\test_desktop_activate.mjs
```

0.6.5 验证：93 项 Node 测试通过（观测、图片、动作、置前、授权、记忆宿主、重放、会话/请求限制）；`scripts/check_dsh_observe.mjs` 在 Electron ASAR 下通过 11 个桌面工具的原生 schema 与注册检查；`scripts/check_dsh_memory.mjs` 通过 4 个记忆工具和 `/memory` 的 schema/注册检查；`scripts/check_memory_host.mjs` 用真实核心 CLI 完成 15 项离线宿主检查（无模型/桌面动作）。`scripts/check_action_ready.mjs` 对真实记事本窗口完成只读 action-ready 观察与契约构建，`gui_actions=0`，临时观察已删除；`scripts/run_action_chain_once.mjs --prepare/--click` 真实点击一次，目标 [22,47]→桌面 [369,113]，动作后截图确认文件菜单展开，`post_action_delta=0.664683`，回执 `results/b02/single-click-20261025/action-chain-live.json`；`scripts/window_activate.py --hwnd 788882` 实测 `foreground_confirmed`，`input_events_sent=0`。Python 全量 236 项测试通过（含 proof、取消、回执真实性、授权、保留、限定重定位、hover 边缘回退、critical region、多步 preflight、运行记录、输入租约、观察计时/变化策略和记忆核心/宿主/C1 暴露账本）。

2026-10-25 现场模型驱动链路已通过：真实 Harness 调用 `desktop_windows` → `desktop_activate`（`already_foreground`，`input_events_sent=0`）→ `desktop_observe(hwnd=788882, include_image=true)` → `desktop_click`，观察 400×300、目标 [22,47] 映射桌面 [82,135]，1 次点击、3 个输入事件、动作后截图确认文件菜单展开，`post_action_delta=0.664683`，`task_success_verified=false`；B03 模板复核 `passed`（0.994782）。证据 `results/vision/49236b35-.../observation.json`、`results/vision/beb2aaf2-.../screen.png`、`results/b02/single-click-20261025/live-activate-20261025.json`、`b03-live-activate.json`。图片通道已按用户要求长期 true；`desktop_activate` 已加载。

2026-10-25 B03：`src/desktop_adapter/verify.py` 以已验证菜单打开模板对现场动作后图 `passed`（相似度 0.994782），对动作前闭合菜单 `failed`（0.823038）；首个重跑验证程序已迁移为 **v2**（`runtime/programs/notepad-open-file-menu/v2.json`），带内容绑定 HMAC proof，动作不含坐标，预期结果引用 `runtime/templates/notepad-file-menu-open.png`。v1 是无 proof 旧记录，`load_program` 会拒绝；proof-bound v2 已真实重放并通过 B03。

2026-10-24，`scripts/run_flash_readonly_trial.mjs` 在用户批准的最多 3 次、¥0.50 范围内，使用相同附件逻辑和已安装 Harness 原生 SDK 完成 1 次真实 Flash 请求。状态识别和目标中心通过，目标框边缘有误差；证据在 `results/b01/flash-readonly-20261023/`。该入口没有运行完整会话或点击，试验状态现为 completed，拒绝再次发送。（历史记录；全局图片开关已于 2026-10-25 按用户要求改为 true。）

下一步验证运行中会话的实际工具调度、完整请求边界以及不同窗口尺寸。当前结果不能代表 B01 全部通过。

0.3.0 本地验证：新增 4 项命令边界/回滚测试，与原有 14 项合计 18 项通过；`scripts/check_dsh_host_command.mjs` 在本机真实原生命令与工具注册器中验证命令解析、调度和生命周期日志，显示器函数及会话使用夹具，无外部请求。报告 `results/a04/dsh-host-command-contract.json` 明确 `running_desktop_host_tested=false`。未实现完整在线会话费用拦截，首轮试验关闭状态及全局图片开关保持不变。
