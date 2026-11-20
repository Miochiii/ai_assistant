# 记忆自动化第一步：点击子任务 checkpoint 离线实现

日期：2026-10-29（UTC+08:00）

接续 `2026-10-29-memory-automation-and-executor-review-decision.md`。当前交付：第一批的有界实现和离线验收；磁盘插件 0.6.5。**正式自动化未启用、运行中插件未重启、真实两会话现场验收未完成**。第二批自动检索/注入尚未开发。

## 完成内容

- 同一独立 SQLite 内新增按 user/project 绑定的宿主同意设置。只通过人类 `/memory automation` 命令修改，启用必须声明期限并确认到期仍保留磁盘正文；未知配置/项目/来源默认关闭。旧启用命令重复投递不能覆盖后来的关闭。
- 首版只连接 `desktop_click` 自身的持久化子任务边界。运行前固定真实请求引用、scope、同意 ID 和实际依赖；运行结束记录稳定事件、输入送达、verification、执行器 stopped/unknown 后才尝试保存。不把单次工具成功写成整个用户任务完成。
- 新 `autoCheckpoint(session,{run_id})` 取代只靠 `consent:true` 的旧接口。核心读取账本，在 SQLite 写事务里复核当前同意并原子写来源/内容/operation；不信任模型摘要或任意 scope。
- 沿用五字段 checkpoint 格式和现有时间字段；仅增量设置表，不迁移/改写原记忆。用户事件仅保存引用，不保存整段请求；宿主生命周期、执行器回执分别是 tool 来源；不保存图片、坐标、完整 stdout 或授权令牌。
- 同事件重复、提交后 ack 丢失均只留一条；不同内容报冲突；删除 operation 不复活。存储失败只重试存储，账本记录 failed，保持桌面实际结果。关闭后排队停止，已提交的 saved 回执仍保留。
- resume 继承 checkpoint/父依赖到当前请求，支持跨轮派生失效；自动来源补充 run 证据 available/unavailable。到期停止恢复，新增只列 ID 的保留/删除预览，无自动物理删除。

## 验收

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Python 全量 | 196 通过 | `results/memory/python-regression-20261029.txt` |
| 自动化/账本专项（含于全量） | 22 通过 | `results/memory/auto-checkpoint-offline.json` |
| Node 全量 | 77 通过 | `results/memory/node-regression-20261029.txt` |
| 真实 SQLite / CLI 宿主隔离验收 | 14 通过 | `results/memory/host-integration.json` |
| Harness 内置 SDK schema/原生注册 | 通过；四模型工具不变 | `results/memory/dsh-memory-contract.json` |

宿主隔离验收使用合成终结事件与两份会话对象，覆盖未启用、显式设置、保存、幂等、第二会话恢复、来源区分、关闭停止和证据缺失；不视为运行中 Harness 现场证据。

受限环境下 Node 子进程报 EPERM、Python 全量遇到 Windows DLL/私有临时目录 ACL 问题，普通本机权限下通过，未改环境依赖。Node 旧测试仍断言只有两个工具，已改为当前六工具的完整逆序注销列表。受限测试创建的 39 个目录逐一核对为项目根直接子目录、非链接、完全为空后非递归清理，证据 `results/memory/cleanup-20261029.json`。正式证据与原 `tmp` 目录保留。

本轮 0 模型请求、0 桌面输入，无安装、无 RAG 环境改动，无正式自动化设置写入。

## 下一步和边界

1. 若用户选择启用范围/期限，重启加载 0.6.5；执行一个已有具体授权的低风险 `desktop_click` 子任务，核对自动保存的真实回执，再从新会话恢复并关闭验证。未选择则继续关闭，不能把“继续开发”当启用授权。
2. `desktop_replay`/独立 PreAct 的自动 checkpoint 尚未接入，需先接妥嵌套执行器终止/恢复事实；普通聊天也不推断任务结束。
3. 第二批自动检索/注入仍需先核对 Harness 的真实请求上下文扩展入口；未宣称任何自动注入已发生。

完整开关、结构和操作流程见 `docs/memory_automation.md`；已更新 README、progress、记忆协议和运行账本说明。本项目当前无 `.git`，没有产生 commit 或 PR。
