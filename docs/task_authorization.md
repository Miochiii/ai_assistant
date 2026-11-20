# 任务授权（2026-10-25）

## 目的

授权不是“允许桌面助手存在”，而是**一次任务内允许操作哪些窗口、哪些动作、到什么时候**。它把
activate / observe / click / replay 放在同一个会话范围内，窗口切换不必每步确认，越界才要求重新授权。

## 创建

用户先运行一次：

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\authorize_task.py --hwnd 788882 `
  --actions activate,observe,click,replay --ttl 3600 --task "打开记事本文件菜单"
```

默认会要求输入 `y` 确认；脚本/受控测试可加 `--yes`。可用 `--list` 查看当前会话授权，
`--revoke <grant_id>` 撤销。`--session` 默认取 `DSH_SESSION_ID`；不传 session 的授权是本机任务授权。

## 绑定内容

授权文件在 `runtime/authorizations/<grant_id>.json`，绑定：

- 窗口身份：`hwnd`、`pid`、`class_name`、`title`，四项都精确匹配；
- 动作集合：`activate`、`observe`、`click`、`replay`；
- 有效期：`expires_at`；
- 可选 Harness session 和程序 ID 白名单；
- Windows session（审计/拒绝跨 session）。

## 执行点

| 入口 | 检查 |
| --- | --- |
| `desktop_windows` | 返回当前 session 的有效授权摘要，便于模型知道哪些窗口已授权 |
| `desktop_activate` | 按 hwnd 选择 `activate` 授权，没有则拒绝，不聚焦 |
| `desktop_observe`（带 hwnd） | 按 hwnd 选择 `observe` 授权，没有则不采集 action-ready 观察 |
| `desktop_click` | 从观察绑定窗口选择 `click` 授权，把 grant_id 放入请求 |
| `preact_replay.py` / `ProgramReplayAdapter` | 选择 `replay` 授权，检查程序 ID；没有则在激活前停止 |
| 固定执行器 | 读取请求里的 grant_id，再次核对窗口、动作、过期、Windows session；没有输入前拒绝 |

`select_grant` 自动选有效授权，所以模型不需要传 grant_id；越界窗口会得到
`AUTHORIZATION_REQUIRED` / `AUTHORIZATION_WINDOW_NOT_ALLOWED`，此时让用户重新授权。

## 真实样本

2026-10-25 为 Notepad `hwnd=788882` 创建一次授权（grant `ebfc1f5b-...`，1 小时，四个动作），
再跑 proof-bound v2：

- 适配器选中授权，`ActionClient` 把 grant_id 放入请求；
- 执行器回执含 `authorization.grant_id`，窗口/动作/session 复核通过；
- 真实点击一次，B03 `passed` 0.994782，菜单已关闭；
- 证据：`results/b02/single-click-20261025/replay-grant-v2.json`、`b03-grant-v2.json`、
  `grant-menu-closed.png`。

## 信任边界

授权文件是本地可信文件，不是签名。它防的是**模型/PreAct 误操作到授权窗口和动作之外**，
不防同一用户下任意本地代码重写授权文件。`--yes` 也意味着自动化脚本可以创建授权；真正的
“只有用户能授权”需要系统级确认/密钥隔离，当前环境没有做。

## 当前限制

- 只匹配当前窗口标题；标题变化（例如保存文件后）会使授权失效，需要重新授权。
- 只按 hwnd 选择 `activate`/`observe` 时不做标题实时复核；执行器对 click 做精确窗口复核。
- 没有动作次数限制、优先级、UI 内授权提示；授权靠 CLI/用户终端。
- 授权过期后不会自动续期。
