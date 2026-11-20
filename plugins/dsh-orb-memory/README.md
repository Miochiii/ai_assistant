# Orb 记忆适配准备层

当前状态（后续更新）：已通过命名开发包 `dsh-orb-mio-dev@0.2.1-mio-dev.4` 接入 DSH。用户已验收显式查询和 PyCharm 自然问答；本轮增加任务检索、持久暴露记录、工具执行前校验与失效后的干净会话切换，实际桌面任务待重启验收。详见 `../../log/2026-11-10-Orb桌面任务记忆接入.md`。以下内容保留为早期开发记录，不代表当前安装状态。

2026-11-10：版本 0.1.0，仅包含可测试的来源/作用域桥接模块。**没有 Cordis apply 入口，没有注册到 desktop profile，没有运行中 Orb 接入。**

同日后续版本为 `0.2.0-dev`：增加切换事务、持久状态和 Orb host 适配，开发副本在 `runtime/dev-orb-memory/orb`。仍无正式安装；见 `log/2026-11-10-Orb开发副本切换事务与持久门禁.md` 的验证范围和限制。后文 0.1.0 的未实现项需结合该记录阅读。

最新补充：`./generation-host` 提供真实 V2 版本；host 薄适配已用命名管道锁住状态/绑定两个路径。52 项相关回归及真实子进程/SQLite/SDK 夹具通过。逐片段 CLI 版本检查仍有明显启动开销，暂不面向真实聊天启用，详见 `log/2026-11-10-Orb真实版本接入与跨进程互斥.md`。

后续性能修复：generation-host 已默认选择常驻轻量 worker，每次仍重读配置和 SQLite；25 次检查累计 293 ms（前轮 CLI 为 4351 ms）。接口尚未安装到正式 Orb，最新实现与验证边界见 `log/2026-11-10-Orb常驻版本查询与延迟复核.md`。

`createOrbMemoryBridge({root, workspace, enabled, host?, userId?})` 默认关闭。配置来自可信宿主，不接受模型提供的工作区。仅接受指定真实工作区、`computer-use` 预设、非子会话中的追加用户事件；要求 `source.kind=user`、消息 ID 和 RPC ID，排除 `code-agent-*`。精确路径经过 realpath，未知路径与任意子目录均不接受。当前只能区分指定工作区的前台 Computer Use 会话，不能区分用户从球还是主窗口向同一个会话发言，也不能作为对恶意插件的鉴权边界。

内部只给 MemoryHost 构造项目根 cwd 的映射，保持真实 session ID，复用已有 `local-user` / 项目根作用域，不修改 Harness 会话。现阶段用户偏好仍属于该项目；未建立跨所有项目共享的个人库。不同项目不会因目录前缀自动加入。

`onSessionEvent` 通过已有 SQLite V2 入口记录 `orb_daily` 来源；来源键使用会话 ID + RPC ID，数据库另绑定 user/project。重复提交幂等，内容不一致由底层事件账本拒绝。明确状态/开关文本直接转到 V2 控制接口，返回值需由未来插件呈现；该模块自身没有 UI，也不拦截主模型。不要记忆、凭据过滤、关闭与撤销待处理队列复用 V2 规则。

目前不自动检索注入、不注册工具、不调度每日抽取。后续调度应由独立应用级扩展负责，复用 `daily_pending` 的数据库租约和原整理器，停用时取消在途任务；不能让每个 Orb 会话创建一个定时器。人格配置与记忆作用域分开设计，尚未实现。

验证：

```powershell
node --test --test-isolation=none tests/test_orb_memory_bridge.mjs tests/test_memory_host.mjs tests/test_daily_memory.mjs
& 'E:/file/agent/python.v/.venv/Scripts/python.exe' -B tests/test_memory_v2.py
```

详见 `docs/orb_memory_integration.md`。不应直接把本目录添加为已完成的 bundle。

## 干净会话准备（2026-11-10 第二步）

`prepareCleanSession` 使用可信宿主的 AgentRegistry 创建无 seed 的新会话，检查旧会话 idle、空 inbox、后台状态明确 clear、记忆版本一致。并发准备、未知后台状态均拒绝；创建期间条件变化会 dispose 本次新建的未使用 handle，不取消旧任务。返回 `status=prepared,bindingChanged=false`，这是有明确生命周期的准备结果，**不是已切换**。调用方必须继续持有 handle，失败/放弃时 dispose。

调用方需在最终绑定事务里重新校验状态并锁住新输入，准备检查不能替代事务锁。`backgroundState` 必须由真实 registry/待投递通知状态提供，不可在生产中写死 clear；`readVersion` 应返回包含开关修订号的非空代次，即使关闭记忆也不能用 null 冒充可用版本。

此模块没有访问或修改 Orb 的私有 runtime、sessionFile 和屏幕所有者。生产切换、退休会话的持久门禁仍待实现。原生恢复验证只证明从新会话日志重建隔离，不证明实际磁盘 persistence 故障或 Orb UI 行为。

```powershell
node --test --test-isolation=none tests/test_orb_clean_session.mjs
$env:ELECTRON_RUN_AS_NODE='1'
& 'E:/dsh/DeepSeek Harness.exe' --expose-internals scripts/check_orb_clean_session.mjs
```
