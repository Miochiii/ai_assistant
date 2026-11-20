# MemoryGateway 核心 v1

2026-10-29 增量：新增同 scope 的 `memory_automation` 设置表；旧 schema v1 通过 `CREATE TABLE IF NOT EXISTS` 兼容，不改变既有记忆行格式。`save_checkpoint` 支持 `valid_from/valid_to`，未带期限的旧 operation digest 不变；宿主自动入口与保留语义见 [记忆自动化](memory_automation.md)。

日期：2026-10-25。范围：C01–C03 本地规则基线，以及 C05 的来源解释结构。C04 开源适配、C06 模型对照与 Harness 实际接入尚未完成。

## 1. 交付与运行边界

- `src/assistant_memory/gateway.py`：唯一写入/检索入口。
- `src/assistant_memory/schema.sql`：SQLite schema v1，独立 application_id `0x4D454D31`；拒绝打开已有其他用途数据库。
- `scripts/memory_cli.py`：本地宿主/管理员的单请求 JSON 入口。
- `scripts/check_memory_core.py`：零网络、零模型调用的验收入口。
- 默认数据位置：`runtime/memory/memory.sqlite3`。本轮只使用隔离测试数据库，未导入真实聊天或创建正式用户记忆。
- 仅依赖 Python 标准库；实测 `.venv` Python 3.14.9 / SQLite 3.50.4。不安装四个参考项目，不修改 RAG、动作执行器和现有插件配置。

它是供可信本地宿主调用的库，不是带身份认证的网络服务。拥有同一用户文件读写/任意代码执行权限者可以篡改数据库，v1 不试图防御这一威胁。

## 2. 数据与生命周期

| 对象 | 关键字段与语义 |
| --- | --- |
| 来源事件 | 稳定不透明 `event_id`、用户/项目范围、session、channel、origin、正文、observed_at、recorded_at |
| 记忆版本 | UUID `memory_id`、kind、key、content、recorded_at、activated_at、valid_from/to、supersedes_id、revoked_at、deleted_at |
| 来源关联 | `memory_sources` 多对多；不能使用跨用户或跨项目来源 |
| 派生依赖 | `memory_dependencies` 指向已有记忆版本，用于失效与删除级联 |
| 搜索索引 | `memory_search` 是可重建副本；不构成事实来源 |
| 审计 | 操作、对象 ID、范围、时间；不复制正文、key、截图或模型推理 |

`kind` 允许 fact、preference、profile、episode、checkpoint。程序与授权令牌不是允许的记忆类型，不提供导入或执行 PreAct 程序的 API。

- `propose` 产生候选，默认检索不可见。
- `remember` 处理宿主确认的显式用户写入，普通记忆必须全部来源于 user 事件。
- `confirm` 将候选激活，追加真实用户确认事件；保留原模型/屏幕来源，不伪装成全部由用户说出。
- `revoke` 撤销指定版本及其派生记录，保留正文供显式历史查询。撤销当前版本不会自动恢复旧值。
- `forget` 清除正文与搜索副本，保留不含正文的删除标记，已删除来源 ID 不能重新入库。

来源角色由宿主从真实消息确定。模型不能自己调用 `record_event(origin='user')` 或把旧用户事件当作针对新候选的确认。核心不理解“正文是否真的表达了这项偏好”；将输入消息映射为显式请求、确认对象的责任属于宿主。

事件必须使用消息/工具事件派生的稳定 ID，且 ID 不能包含姓名、消息正文、路径等隐私内容。相同 ID、相同内容的重复投递幂等；变更内容/范围/角色返回 `SOURCE_ID_CONFLICT`。删除后复用 ID 返回 `SOURCE_DELETED`。

同一 `(user, project, kind, key)` 表示一个版本序列。新建时 `supersedes_id=null`；修订必须指定最新已激活版本的 ID，否则 `REVISION_CONFLICT`。两个进程对同一旧版本修订只有一个能提交；所有检查、正文、来源、索引和审计在同一事务内提交。

v1 不合并自然语言同义 key。宿主维护稳定的键，如 `report.directory`，不能每次由模型随机生成新键而绕过更正规则。

## 3. 时间与历史

时间必须带时区，存储规范化为 UTC 微秒字符串。

- `observed_at`：来源事件发生的时间。
- `recorded_at`：本地得知/保存时间。
- `activated_at`：候选获准参与检索时间。
- `valid_from`：事实开始有效的时间；`valid_to` 是可选的显式到期时间。
- 时间区间左闭右开。没有显式到期时，下一版本的生效时间隐式结束旧版本的当前适用性，旧行不覆写。
- 未来生效的 B 不替换今天有效的 A。B 到期或撤销后返回无有效值，不自动回退 A。
- `at` 查询的是“按目前保留的知识，在指定有效时间应采用什么”，不实现“系统在过去当时知道什么”的完整双时间重建。撤销项不会因指定过去时间而恢复为有效事实；需要查看它时使用 history。

v1 的修订有效时间必须不早于上一已激活版本的 valid_from；相同时间允许纠错，由新版本取代旧版本。向已有计划中插入更早的修订会返回 `NON_MONOTONIC_VALID_TIME`，不猜测如何重排整个时间线。复杂计划取消/回溯修订是后续扩展，当前不得通过新建另一 key 绕过。

## 4. 检索与解释

`recall(route=..., kind=..., key=..., query=..., at=..., limit=10, max_chars=24000)`：

| route | 行为 |
| --- | --- |
| none | 无需记忆，立即返回空结果，不读取正文 |
| current | 必须 kind + key；返回当前有效版本，并列出其他版本的排除原因 |
| history | 必须 kind + key；显式查看保留版本，包含候选和撤销项，按新到旧排列 |
| search | 对有效内容做 NFKC/casefold 后的字面子串检索；空格分隔的多个片段必须全部出现 |

路由由宿主/规划器显式选择，v1 不用关键词猜测自然语言问题意图。搜索支持中文短语，不要求额外分词组件；排序使用命中次数和版本顺序，不是语义相似度、置信度或 FTS/BM25。单用户小库基线会扫描范围内记录，尚未做大规模性能优化。

先检查用户/项目范围、候选状态、时间、版本、撤销与依赖，再限制结果数量。无匹配返回空，不用邻近事实补答案。

结果包含 memory_id、正文、来源事件及原文、时间、supersedes_id、depends_on、状态与原因。常见原因：`selected`、`candidate`、`revoked`、`not_yet_valid`、`superseded`、`expired`、`dependency_unavailable`、`literal_text_match`。

结果数量 1–100；内容与证据的 JSON 字符总数默认上限 24000，可设为 512–64000。这是字符预算，不是 token 预算。过大的整条证据被跳过，返回 `context_budget_exceeded` / `truncated`；不偷偷截断证据再冒充完整记录。管理导出不使用这个预算。

所有召回记录均带 `trust=context_only`、`execution_authority=false`。宿主必须把它们作为带来源的上下文数据注入，不能拼成 system 指令或从记忆文字生成执行确认令牌。

## 5. 任务检查点与经历

`save_checkpoint(task_id, content, source_event_ids, supersedes_id=None, depends_on=[])` 保存：

```json
{
  "goal": "整理报告",
  "completed": ["读取资料"],
  "next_step": "重新观察桌面并选择测试窗口",
  "blockers": [],
  "status": "in_progress"
}
```

status 仅允许 in_progress、blocked、completed，表示上次工作摘要的声明，不是任务成功认证。检查点允许模型/工具来源直接保存为工作上下文，不据此提升普通事实或偏好。

`resume(task_id)` 返回来源，并固定声明 `requires_fresh_observation=true`、`automatic_execution=false`、`task_success_verified=false`。检查点不接受窗口句柄、坐标、授权 token 等额外字段，也不自动执行 next_step。

摘要使用过的记忆版本必须全部写入 depends_on。上游被更正、尚未生效、到期、撤销或删除，派生摘要不再默认召回。若调用方遗漏依赖，核心无法仅凭自由文本发现它；宿主应把摘要生成时提供的记忆 ID 自动带入，不能让模型选择性申报。

episode 当前仅允许 `{"summary":"...","outcome":"unknown"}`。收到输入事件不等于任务成功。读取现有动作验证器证据并晋升经历结果的桥接尚未实现，故 v1 拒绝 success/failure 写入；也不允许通过记忆创建 verified 程序。

## 6. 删除、隐私与持久化

`deletion_plan(memory_id=...)` 或 `deletion_plan(event_id=...)` 返回受影响的记忆/事件 ID。`forget` 在事务中重新计算并清理：

1. 目标版本所在的整个 key 历史，包括候选。
2. 所有声明依赖这些版本的记录及其版本序列。
3. 来源正文，以及共享这些来源的其他记忆；递归至稳定。
4. 上述对象的搜索副本。

这会保守地多删。例如一条用户消息包含两项偏好，删除其中一项会删除共享来源的另一项；宿主应使用可独立擦除的小段来源，并在删除界面展示 plan。删除一个版本表示忘记这条事实及其派生记录，不是恢复前一个版本。

保留的墓碑只有标识、范围、结构关系和时间等元数据；清除来源正文、session/channel 文本及记忆正文/key。墓碑防止同一事件 ID 重放，但不能识别换了新 ID 的同义内容。宿主重新导入聊天时必须维持稳定来源 ID；没有自动导入/恢复入口。

SQLite 使用 DELETE journal、secure_delete、FULL synchronous，避免本模块长期保留 WAL 中的旧正文。承诺范围是当前库的逻辑删除，不是 SSD、文件系统快照或备份的取证级抹除。模块不自动备份，不保存截图；历史 Harness 消息、已有 A03 事件库、用户导出和模型已收到的上下文不在本库删除范围，`external_copies_erased=false` 始终显式返回。

应用自己建立外部缓存、导出、备份或向量库时，必须先补齐相应删除协调。不能把旧导出直接恢复到生产库后声称删除仍有效。

## 7. Python 与 CLI 接入

```python
from assistant_memory import MemoryGateway, Scope

with MemoryGateway("runtime/memory/memory.sqlite3", Scope("local-user", "assistant-project")) as memory:
    memory.record_event(event_id="host-message-001", session_id="session-1", channel="harness",
                        origin="user", content="记住：报告保存到目录A。")
    first = memory.remember(kind="preference", key="report.directory", content="目录A",
                            source_event_ids=["host-message-001"])
    result = memory.recall(kind="preference", key="report.directory")
```

CLI 使用 UTF-8 stdin/stdout，一个进程一个请求，成功退出 0，错误退出 1。数据路径和身份由宿主命令行固定，不接受请求 JSON 更改这些参数。

```powershell
'{"op":"recall","args":{"kind":"preference","key":"report.directory"}}' | & '.\.venv\Scripts\python.exe' -B scripts\memory_cli.py --user local-user --project assistant-project
```

可用 op：event、propose、remember、confirm、recall、revoke、deletion_plan、forget、checkpoint、resume、rebuild_index、export、audit。成功格式 `{"ok":true,"op":"...","result":...}`，错误格式 `{"ok":false,"error_code":"..."}`。不要根据工具退出成功推断业务结果。

它是可信宿主/管理员入口，**不能将完整 CLI 原样暴露成模型工具**。后续模型只提交候选或范围内读取；event、显式 remember、confirm、撤销/删除由宿主从真实用户意图构造。Python 库不是进程权限沙箱，也没有防本地恶意写者的签名机制。

CLI 不记录请求正文，错误不回显参数。存储不可用返回 `STORAGE_UNAVAILABLE`，调用方应提示未保存，而不是在模型回答中声称“已记住”。

## 8. 验收

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\check_memory_core.py --output results\memory\core-v1.json
```

2026-10-25：27 项通过，包含两进程竞争修订、进程退出事务回滚、跨进程读取、未来生效与到期、用户/项目隔离、删除后重开与重建、派生摘要失效、候选确认、来源重投递、字面检索、上下文预算、错误数据库拒绝和 Unicode CLI 往返。

报告包含源码 SHA256、运行版本、测试名称和限制。测试仅用虚构数据；临时数据库位于 `runtime/memory-tests/<UUID>`，测试结束关闭连接并清理。Windows 受限 token 下避免 Python 3.14 私有临时目录权限问题，使用继承工作区 ACL 的独立目录。

这不是正式 LongMemEval 成绩，也不证明模型能正确抽取偏好或选择路由。未执行付费 API、桌面动作、自动记忆插件加载或真实聊天导入。
