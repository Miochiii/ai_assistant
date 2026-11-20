# 桌面运行记录与幂等收尾 v1

2026-10-27。参考 `log/2026-10-27-game-plugins-reference-for-deepseek.md` 的第一步，只实现宿主记录层，不替代执行器、授权、B03 或程序 proof。

## 目的

把“动作是否送达”“界面是否变化”“目标条件是否成立”“记忆是否保存”分开记录。`verified_success()` 只是单个验证记录的粗略门槛，不是任务成功证明；退出码、模型 final、报告存在都不够。

## 字段

`src/desktop_adapter/runs.py` 的 `RunLedger` 保存：

| 字段 | 含义 |
| --- | --- |
| `run_id` | 宿主生成的单次运行 UUID |
| `task_id` / `request_id` | 任务/请求身份，由宿主提供 |
| `policy_version` / `scope` | 策略版本和用户/项目范围 |
| `lifecycle` | `queued` / `running` / `waiting_user` / `stopping` / `ended` |
| `termination_reason` | `completed` / `cancelled` / `timeout` / `error` / `interrupted` / `replan_required` / `stopped` |
| `input_delivery` | `not_sent` / `sent` / `unknown` |
| `verification` | `{status: passed|failed|unknown, ...}`，不是布尔值 |
| `checkpoint_write` | `pending` / `saved` / `failed` / `skipped` |
| `operations` | 已应用的幂等 operation_id → 请求摘要 |

原子写入 `runtime/runs/<run_id>.json`：临时文件 + `os.replace`，跨进程文件锁；不是多写者事务数据库。

## 幂等与恢复

- 每次状态变化必须带 `operation_id`。
- 同一 operation_id 重投返回原记录；同 ID 不同变更返回 `RUN_OPERATION_CONFLICT`。
- `ended` 后拒绝新变更（`RUN_ENDED`）。
- 重启只列出 `unfinished()`，不自动重跑、不自动补动作。
- `mark_interrupted()` 是显式收尾，仍需人工核对执行器；不能证明最后一个动作未发生。
- **不自动重试**；输入前由固定执行器获取跨进程租约，见下节。

## 桌面输入租约

`src/desktop_adapter/lease.py`：

- 锁文件 `runtime/locks/desktop-input.lock`
- 使用 Windows `msvcrt.locking(LK_NBLCK)` / POSIX `fcntl.flock(LOCK_NB)`
- `scripts/desktop_executor.py` 在 `executor.execute(payload)` 前获取，输入和动作后截图都在租约内
- 第二个并发请求返回 `DESKTOP_BUSY`、`input_delivered=false`、`other_action_may_be_active=true`，不等待、不重试、不关闭其他程序
- 崩溃时 OS 释放锁，但最后一个输入仍可能已发生；必须看回执

## PreAct 接入

`scripts/preact_replay.py` 每次重放创建一个 run：

- `task_id = program:<id>:v<version>`
- `request_id = DSH_SESSION_ID`（如有）
- 只在 `DSH_MEMORY_PROJECT` 存在时写 scope，不用共享 unknown
- `status=completed` → `termination=completed`，`verification=passed`（来源 `inventory.replay`）
- `replan_required` / `stopped` → 终止原因保留，`verification=unknown`
- `receipts` 非空才把 `input_delivery=sent`；否则 `not_sent`
- `checkpoint_write=skipped`，因为本阶段没有自动 checkpoint

输出 JSON 增加 `run_id` 和 `run_record`；原 `result` 不变。

## Node 单步点击接入

`plugins/dsh-desktop-observe/runs.js` 是宿主 CLI 桥：

- `desktop_click` 在调用执行器前写 `start`
- 执行器返回后写 `end`
- `input_delivery` 来自执行器回执，不把 `ok` 直接当任务成功
- `verification=unknown`（Node 工具没有独立 B03；界面变化/after image 不等于目标条件成立）
- `checkpoint_write=skipped`
- `run_id`/`run_record` 加到工具输出；`task_success_verified` 仍为 false
- ledger 启动失败时**不发送点击**；ledger 收尾失败只加 `run_ledger_error`，不掩盖已发生的输入

## `desktop_replay` 宿主工具

`plugins/dsh-desktop-observe/replay.js`：

- 只接受 `program_id` / `version`，不接受坐标、代码或动作数组
- Node 读程序步数，当前只允许单步；Python `load_program` 验证 proof/内容/版本
- 调用 `scripts/preact_replay.py`，一次内部完成 preflight/observe/locate/execute/verify
- 返回紧凑状态、步骤、receipt 数、证据路径、`run_id/run_record`
- `program_condition_verified` 只表示程序声明的后置条件；`task_success_verified=false`
- 失败/unknown 不重试；超时/取消返回 unknown，可能已有输入
- 没有图片附件；证据留在 `results/desktop-replay/`

实机无授权冒烟：真实 Node 包装启动 Medium base Python/CLI，程序在授权检查处返回 `AUTHORIZATION_REQUIRED`，未激活、未截图、未输入，`input_delivery=not_sent`、`verification=unknown`。证据 `results/desktop-replay/no-grant-smoke-20261027.json`。这不是成功重放样本。

## 测试

```powershell
& '.\.venv\Scripts\python.exe' -B -m unittest tests.test_runs tests.test_lease -v
```

7 项：

- 生命周期与 verified_success 分离
- 重复 operation_id 幂等/冲突
- 非法转换和终止原因
- unfinished 只列出不重跑，显式 interrupted
- JSON 持久化
- 第二个租约返回 `DESKTOP_BUSY`，释放后可重取
- 租约目录自动创建

`tests/test_desktop_action.mjs` 另有 fake 执行器测试，验证点击前 start、点击后 end、`verification=unknown`。

跨进程实测：另一个 Python 进程持有租约时，执行器返回 `DESKTOP_BUSY`、`input_delivered=false`、`input_events_sent=0`，未发送输入；证据 `results/run-ledger/lease-busy-20261027.json`。Node → Python ledger 桥也做了合成 run 检查，证据 `results/run-ledger/node-client-check.json`。两者都不是真实桌面点击。

## 限制

- Node 点击写入的 `verification` 仍是 unknown；没有把 after image/B03 自动升级成 passed。
- 未接 `ActionClient` 的 Python 调用者到 run ledger；PreAct CLI 和 Node 点击已接。
- 没有自动 checkpoint 任务结束触发器；`autoCheckpoint` 只是宿主接口。
- 租约只防并发输入，不防同一用户直接调用 Win32；它不是 OS 安全边界。
- `verified_success` 是粗粒度；多步/目标条件由库存重放结果负责。
- 不把记录写进长期记忆；记录不包含截图、模型原文或凭据。
- Node 点击和 PreAct 新接入尚未做真实桌面 live 重放；当前只通过离线测试和 fake 执行器。
## 2026-10-29 增量：自动 checkpoint 交接

磁盘插件 0.6.5 的 `desktop_click` 在有项目同意时于启动前固定 `scope/memory_context`（请求、用户事件引用、同意 ID、依赖 ID），终结时记录稳定 `terminal_event_id/ended_at`、`executor_state` 和白名单 `checkpoint_facts`。终结事实仍不可重开；存储确认可在 ended 后单独更新 `checkpoint_write`。保存失败不会改变输入或验证结果，旧中断记录不推断执行器已经停止。真实加载/现场验收未完成，正式默认关闭，replay 暂未连接。详见 [记忆自动化](memory_automation.md)。

