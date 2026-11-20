# 记忆核心 v1：Harness 接入交接

2026-10-25。核心代码与协议见 `docs/memory_contract.md`。当前可直接运行离线验收；无需重启 Harness。此前桌面插件、程序库及 RAG 保持原样。

> 2026-10-27 状态：宿主薄接入 v1 已实现，代码与验收见 `docs/memory_host_integration.md`。新增四个模型工具和人类 `/memory` 命令；未把 CLI 暴露成模型工具。离线核心 31 项、宿主 10 项通过；Harness 已重启，四个工具已 live 加载并通过 recall/propose/history/resume 检查；`/memory` help 可用，两会话命令已实际成功但新空会话结果行可见性仍待查。新增 host-only `autoCheckpoint` 接口和核心幂等 checkpoint，未接触发器。

## 当前完成

- C01：来源/候选/有效版本/撤销/删除的数据结构和时间规则。
- C02：显式写入、确认、修订、撤销、级联擦除、来源查询；跨进程持久化。
- C03：当前精确查询、历史路由、字面检索、无需记忆路由、索引重建。
- C05：已有规则层来源解释结构；整个任务仍待 C04 适配后验收。
- 27 项本地开发回归通过，报告 `results/memory/core-v1.json`。不把此结果写成模型记忆准确率。

## 建议 DeepSeek 下一步只做宿主薄接入

1. 从当前 Harness 的真实用户消息事件取得稳定消息 ID、session ID、角色、工作区 ID；固定本机 user scope。项目 scope 用宿主规范化后的稳定 ID，不把模型给出的路径直接当身份。
2. 单独封装核心 Python/JSON 调用，配置固定数据库路径。不要新增第二个记忆存储或同时开启 dsh-memory-evolve 自动写入。
3. 用户明确要求记住或更正时，由宿主生成来源与写入；模型自主抽取只能 propose。读取时先 exact current，必要时 search/history；无法确定 key 时不要随机生成多个同义 key。
4. 将检索内容放进标注来源的资料区。保留 `execution_authority=false` 和排除原因；对来源超预算、存储失败、无匹配给出真实状态。
5. 任务结束保存一次检查点，并自动携带本次摘要使用的 memory_id 作为 depends_on。下次恢复时重新观察桌面，不执行检查点中的旧窗口/坐标或旧授权。
6. 删除界面展示 deletion_plan 影响范围，执行 forget 后失效宿主自己的缓存。若宿主没有缓存，明确写“无缓存”；不要声称已删 Harness 历史消息。
7. 用两个新 Harness 会话验收“目录 A → 目录 B → 历史查询 → 删除”，最后重启复查。此阶段不需要真实桌面动作。

## 接入时需要核实的信息

核心实现不依赖 DeepSeek 提供额外说明。接 Harness 时，如现有代码不能直接确定，只需提供以下脱敏代码片段或接口说明，不需要密钥、完整聊天库或私人截图：

- 当前实际加载的插件源码路径/版本，以及用户消息事件中稳定 ID、角色、会话、工作区字段的最小示例。
- 本次模型请求前注入额外上下文的实际 hook/接口；插件是否能知道哪些记忆进入了该次请求。
- 是否已经有自动记忆写入器、摘要缓存或插件在后台运行，以及关闭入口。

这些字段不能从假设的 SDK 名称编写；以当前安装的 Harness/插件代码为准。

## 必须保持的边界

- 不将整个 CLI 直接注册为模型工具；scope、source origin 和用户确认来自宿主。
- 不修改 `runtime/programs`、程序 proof 或动作授权规则。普通记忆只能提供上下文。
- 不把 checkpoint 的 completed 或 episode 摘要当成独立验证结果。核心当前只接受 outcome=unknown 的经历记录。
- 不把整个屏幕或 QQ 历史自动写入长期记忆。首轮只测试明确用户偏好与任务摘要。
- 非单调有效时间修订、完整双时间查询、语义召回、自动人格更新、官方 LongMemEval 对照都不是本轮完成项。

## 参考源码采用情况

此次参考本地下载源码的设计，核心没有复制第三方实现或引入其依赖；版本来自本地声明，不声称是上游最新版本。ZIP 下载没有可核实 commit，使用文件 SHA256 固定阅读依据。

| 项目 | 本地版本/许可 | 参考点 | 本轮处理 |
| --- | --- | --- | --- |
| dsh-memory-evolve | package.json 0.1.0 / MIT | lib/store.js 的作用域、来源、串行写入；入口与自动整理能力留作接入参考 | 不加载其后台功能；本项目统一使用事务数据库 |
| Mem0 | pyproject 2.2.1 / Apache-2.0 | memory/storage.py 的历史记录；memory/main.py 的显式增删改查、批量删除 | 不把删除向量记录等同于擦除历史；不使用默认推理/嵌入/遥测配置 |
| LangMem | pyproject 0.0.30 / MIT | knowledge/tools.py 的 namespace、create/update/delete；extraction.py 的候选整理和可配置删除 | 采用明确范围与候选流程，不引入 LangGraph 或自动模型提取 |
| LongMemEval | README / MIT，未确定发行版本 | 信息抽取、多会话推理、知识更新、时间推理、拒答分类 | 用于设计本地案例；没有下载完整数据或运行官方评价模型 |

固定阅读文件指纹：

```text
dsh-memory-evolve-main/lib/store.js
F589AD56CB1025EBF6D7CBE036790F8AE186E5EFDDE50FC9BBD8E72123FC180E
mem0-main/mem0/memory/storage.py
5F5ECDADD2B260FD14F36A0F338336EB760275465DD1056A99A47E1EF07702BD
mem0-main/mem0/memory/main.py
F329CA4A17AF1FBEFB32AC10D4CC7AE7DDBDB7435A87EB74C30915CFF98B8B7C
langmem-main/src/langmem/knowledge/tools.py
0118D3623A19C9B6C8C3D477AEAD51F08EEB44771C3AE3F51CD32D8A800B78D7
langmem-main/src/langmem/knowledge/extraction.py
165D4C019F55A365DBA5A551E1AF0C0313A2F4BAB292E47493ACC6F1CD62C13E
LongMemEval-main/README.md
C4FF45676683D9E2F7CF7D9099D26426F14635EC110DBB1DA818D1019A142573
```
