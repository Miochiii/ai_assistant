# Orb 记忆代次切换：验证结论与最小接口

日期：2026-11-10。安装组合：Harness 0.2.2-rc.1 + Orb 0.2.1。当前完成准备模块与原生 SDK 隔离验证，未实现或挂载生产切换。

后续更新：开发副本已实现切换事务、磁盘门禁和失败恢复；Harness 原生钩子已用模拟 Orb runtime 验证，尚未安装或验收真实 UI。见 [开发副本记录](../log/2026-11-10-Orb开发副本切换事务与持久门禁.md)。下文保留前一阶段审计与目标接口，完成范围以新记录为准。

## 已验证部分

`plugins/dsh-orb-memory/clean-session.js` 创建没有 seed 的新 Computer Use 会话，仅复制可信 cwd/预设和模型选择配置，不复制用户历史、助手回复、工具消息、摘要或待办消息。保留旧会话及其日志。

创建前后核对旧会话 idle、两类 inbox 为空、AgentRegistry 中仍为同一实例、后台状态明确 clear、记忆代次未变。准备失败只释放新建 handle，不停止旧任务。模块返回 prepared，不修改前台绑定；调用方必须在最终绑定前再次检查并冻结输入。

`scripts/check_orb_clean_session.mjs` 使用安装版 SDK 与假模型：

1. 旧会话注入合成记忆，经过一次真实原生工具调度生成工具结果和派生回答。
2. 创建新会话，下一模型请求没有旧记忆、工具历史或派生回答。
3. 对旧调用者安装 agent/pre-step reject，投递 Orb 格式 computer-use/notice；未产生新的模型请求或工具调用，也未进入新会话。
4. 在另一个独立 Context 中从新会话完整事件日志恢复，再次请求仍没有旧内容。

共 4 次假模型请求、1 次合成工具执行，无网络、付费请求、桌面输入或正式记忆访问。证据 `results/memory/orb-clean-session-20261110.json`。6 项准备模块测试覆盖忙碌/排队/未知后台、版本及状态竞态、目标带历史、取消和并发冲突。

恢复测试使用日志 seed 和新的内存运行时，未走真实磁盘 sessionPersistence；旧会话门禁在夹具中是临时的，尚未实现跨重启持久门禁。在途内容一旦展示无法靠切换撤回。

## 为什么不能直接调用 Orb 的“新建”

已安装 `dist/host/index.js` 中 runtime 在 apply 内部构造，未通过 ctx.provide 或包 exports 发布前台切换服务。`newSession/adopt/remember` 是内部方法。直接调用 Harness create 只创建会话，悬浮球、屏幕所有者、消息水位仍指向旧会话。

`remember` 先修改 runtime.sessionId 和屏幕所有者，再写 sessionFile；写失败被捕获后仍广播新 ID 并成功返回。因此不能把现有返回值当作持久切换成功。不可通过直接改 sessionFile、调用私有 socket 或篡改 runtime 对象绕过这段生命周期。

此外 `code-agent-registry-5tmIstVY.js` 的 runWatch 在后台及旧 caller 空闲后，仍会向旧 caller.followup 投递通知。仅把球切到新会话不会使旧 caller 自动退休；旧 caller 有机会重新启动模型和 GUI 流程。必须让退休门禁在任何新请求前生效，不能仅过滤新会话的消息。

## 下一阶段的最小可追踪适配接口

优先向 Orb 提供一个小型版本化 host 服务，不 fork 全部桌面循环。安装目录保持不变，先在开发副本中实现和验收。接口应由 Orb runtime 自身拥有：

- `inspectBinding()`：返回当前会话、工作区、绑定修订、在途 turn/prompt/问答/lasso 状态及保存状态；不能只返回 sessionId。
- `prepareMemoryCutover(expectedBinding, memoryGeneration)`：串行持有输入接入锁，检查前台/后台与待投递通知；有任务或未知状态返回 deferred，不取消任务，也不自动重试动作。
- `commitMemoryCutover(preparedHandle, expectedBinding)`：先持久记录旧会话退休和新代次；原子保存新绑定并回读，再更新屏幕 owner、runtime、UI 与水位。返回可核验回执；中途失败进入可恢复的 pending 状态，不重新创建无限个会话。
- 启动恢复：先核对持久切换记录与 sessionFile，恢复退休门禁，再允许 prompt 或后台 notice。记录缺失/损坏时禁用受影响的记忆会话，不把“不知道代次”当作干净。

代次记录置于 E 盘，保留会话 ID、作用域、版本和状态等元数据，不保存记忆正文。准备状态与成功状态分开，锁期间的新用户消息保持排队且有原 RPC ID，提交后仅投递一次；取消或失败不得悄悄丢弃消息。

退休门禁须覆盖重开旧历史、后台通知、直接从主窗口提交和版本在请求准备后变化的情况。插件停用时仍需由 Orb 小型适配保留受影响旧会话的隔离保证，同时允许新建无记忆的普通会话；不能把必须存在的安全状态只放在可卸载插件的内存 Map。

## 未完成清单

生产前台绑定事务、输入冻结、持久门禁、在途撤销处理、真实后台 registry 状态、磁盘故障恢复，以及扩展停用后的降级均未完成。当前不注册自动注入、不修改用户 Orb 配置，不要求用户重启。完成这些以后再接每日整理/人格加载与真实跨会话验收。
