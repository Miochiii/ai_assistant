# Memory Evolve 本地插件接入

用户提供 `third_party/dsh-memory-evolve` 源码并要求接入。使用包内现有 `lib`，包版本 0.1.0；没有修改上游插件源码。Orb 开发包更新为 0.2.1-mio-dev.7，仅增加旧后端停用后的会话隔离模式。

## 安装与配置

官方 CLI `dsh plugin --profile desktop add <local-link>` 返回 desktop 由 Electron 独占管理，未执行安装。随后通过有备份、哈希前置检查和错误回滚的 `scripts/install_evolve_local.ps1` 注册本地 link 依赖、同名 bundle、node_modules Junction 和对应 lockfile 条目。未执行下载、npm 生命周期脚本或修改 DSH 核心。

配置备份及安装后哈希：`runtime/evolve-install/20261111/installation.json`。配置来源：`configs/evolve-integration.json`。新数据：`runtime/memory-evolve`，不写进第三方源码目录。

desktop profile 禁用 `orb-memory`，使旧采集、跨日整理、显式命令、自然问答和每任务检索全部停止。`orb-host.taskMemory.legacyGuardOnly=true` 保留旧暴露历史的退休校验：启动时标记旧暴露会话退休，下一项任务进入干净会话，不复制旧消息；新会话不再调用旧记忆库，也不记录新后端暴露。旧版本记录文件原样备份。此检查只保护旧后端迁移，不能宣称为新插件提供了相同的撤销语义；新插件使用其自身上下文机制。

新插件开启记忆快照、管理 Tab、重要项目记忆提示，渐进披露设为 auto。关闭每轮项目/每日日志、写入看门狗、定期审查、自动技能同步、待办、外部派单、消息发送、同步、Advisor 等额外功能。插件默认必带的 `memory` 和 `skill_manage` 工具保留，不修改源码裁剪。

## 数据迁移

通过 SQLite backup API 从只读源连接保存 `legacy-memory.sqlite3`，在副本上计算有效状态并输出 `legacy-export.json`。原 SQLite 不修改。

- 1 条已生效、原本允许自动使用的普通记忆迁入当前 Orb 工作区 KEY 轨。
- 17 条旧便笺/指导偏好/任务记录进入项目归档，避免把显式查询便笺或任务 checkpoint 自动升级为通用事实。
- 3 条旧候选迁入插件待确认队列，不自动采纳。
- 1 条已被替代的记录只留在原库和导出快照。

逐条映射见 `runtime/evolve-install/20261111/migration.json`；新数据内也保存来源映射。每条迁移记录保留旧 ID 和记录时间，完整来源事件保留在导出快照。

## 验证与限制

- 旧任务门禁 13 项测试通过，包括迁移模式不调用旧检索、旧暴露会话退休、新任务切换后提交。
- `scripts/check_evolve_integration.mjs` 用真实插件、临时库和模拟 Host 验证工具注册、KEY 写入候选、人工采纳、读取、更正、删除及 HTTP 路由注册。报告 `results/memory/evolve-integration.json`。
- `scripts/check_evolve_native.mjs` 用实际 DSH 0.2.2-rc.1 SDK 和模拟模型验证工具注册、runtime context 注入、已安装 profile 的 YAML 和本地包解析。无付费模型请求或桌面操作。报告 `results/memory/evolve-native.json`。
- 上游部分测试在当前受限环境中未全部通过：默认测试尝试同步技能至用户目录被拒绝，另有 git 分支相关用例失败。没有把这一批计为通过，也没有为通过测试改上游代码。部署配置显式关闭内置技能同步；针对实际部署配置的上述两项接入测试通过。
- 尚未重启用户 DSH，不能宣称实际运行界面已经加载成功。新插件有自己的记忆策略，不再沿用旧“第二天自动整理”承诺；项目关键记忆默认先进入确认队列。

## 重启后验收

1. 完全退出并重开 DSH，主窗口查看当前 Orb 工作区会话的“记忆”Tab。
2. 查看项目关键记忆、归档和待确认队列；3 条旧候选按正文决定采纳或拒绝，不直接批量采纳。
3. 新建 Orb 会话，问“我用什么写 Python”，检查迁移记忆是否可用。
4. 要保存布局，可说“请把 program 的位置保存为项目关键记忆”，随后在主窗口采纳候选。也可在支持命令的主窗口用 `/memory_review list` 查看、`/memory_review approve 序号` 采纳。

旧“自动记忆状态”“整理昨日记忆”已不再由本地服务截获，不能继续用作新插件的状态/调度验收命令。用户的 RAG MCP 服务与原项目保持不变，本轮未把变点检测接进新插件。

回滚前须先备份新插件数据，核对安装后配置哈希及当前会话状态；恢复配置后从新会话开始，不能把含新插件记忆的历史当成未暴露会话继续使用。不要覆盖已有数据或删除旧暴露账本。
