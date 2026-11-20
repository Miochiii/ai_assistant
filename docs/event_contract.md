# A03 统一事件契约 v0.1.0

实现：`src/assistant_core/events.py`。不需要 NumPy、模型或第三方依赖。SQLite 保存持久状态，JSONL 作为可复核导出。SQLite 不是此时已经实现的记忆模块。

run 绑定 session_id、user_scope、scenario_id 与版本。每个事件包含 run_id、event_id、component、version、started_at、ended_at、status、error_code、evidence_ids、cost，导出时带上会话、用户作用域和 schema_version。时间使用带时区 UTC；观测、动作、结果验证、记忆读写、回答、评价通过 parent_event_id 和同一 run 关联。

## 状态与业务结果

- 运行状态：running → completed / failed / timeout / interrupted。
- 业务结果：success / failure / unknown，初值 unknown。
- 工具完成不代表目标完成。只有 verification 事件引用同一 run 下已经登记的证据后，才能写入确定的业务结果。关闭 run 时须显式指定验证事件。
- 验证器完成并发现结果不符为 completed + failure；验证器自身异常、超时或中断为 unknown。
- 未完成事件阻止正常关闭 run；进程重启只读取持久状态，不重放动作。确认旧执行者已退出后，可用 interrupt_run 标记未完成事件为 interrupted，run 仍为 unknown。
- 完成事件不能覆写；跨 run 的父事件、证据或验证结果被拒绝。检查和写入放在同一 SQLite 写事务中。
- 未知费用保存为 JSON null。确知本地模拟无 API 费用时可显式填 amount=0、currency=USD、source=local_simulation；0 不表示 CPU 或时间成本为零。

## 证据与限制

证据记录含 evidence_id、run_id、kind、reference、created_at。reference 指向独立结果文件或构造夹具；日志中不需要复制屏幕正文、密钥或个人记忆。JSONL 同时导出 run、证据清单与事件，避免出现无法追溯的裸 ID。

此存储是单用户本地开发接口，不是权限认证系统。调用者可登记虚构证据，因此仍需外部结果验证器与可信宿主来约束调用，模型不能自行把口头判断登记为真值。文件存在性/哈希由产生证据的组件负责；当前不提供加密、防篡改签名、多租户隔离或自动恢复所有运行的后台任务。

观察中的 observation_id、窗口/PID、界面版本，以及 answer_id、memory_id 等由各组件在 payload 中记录；A03 不伪造尚未实现的桌面和记忆能力。

## 验证和示例

在项目根目录的普通本机 PowerShell 执行：

```powershell
& '.\.venv\Scripts\python.exe' -B -m unittest discover -s tests -v
& '.\.venv\Scripts\python.exe' -B scripts\demo_events.py
```

14 项事件协议测试已通过。例子输出为 `results/a03/synthetic_success.jsonl` 和 `synthetic_interrupted.jsonl`；全部使用虚构资料，后者重新打开数据库后显式标记未完成操作，不能当作桌面实测结果或恢复可靠率。后续真机读取另行记录。
