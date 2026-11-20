# Harness 启动失败：本机认证 Cookie 累积导致 HTTP 431

日期：2026-11-05。版本：DeepSeek Harness 0.2.1-rc.5。

## 问题与证据

用户在接入助手面板对话后重启，出现 `desktop welcome: Web authentication failed`。正常重启以及禁用全部第三方插件均未解决。

读取安装包源码发现：桌面启动先使用 Node fetch 获取本机认证 Cookie，随后 `connectDesktopWelcome()` 使用 Electron net.fetch 访问 Host 的启动地址。后者非成功响应会抛出上述错误。

本轮临时网络诊断确认：Electron 请求 `http://127.0.0.1:<本次随机端口>/`，走 `direct://`，返回 `HTTP/1.1 431 Request Header Fields Too Large`。不是这一请求被代理转发。

仅查询 Cookie 元数据，发现 Harness 自己的 Cookie 数据库中，`127.0.0.1` 下有 71 个 Cookie，全部为 `dsh-auth-*`。数据库 quick_check 正常。没有输出 Cookie 值。

安装包 `@deepseek-ai/dsh-client-connection` 的 cookieName(authority) 使用 authority 的 SHA-256 生成不同名称。结合随机启动端口及 Cookie 不按端口隔离的行为，可解释多次启动后的累积。单纯重启或禁用插件不会清除这些 Cookie。

## 修复

退出诊断进程后，使用 SQLite backup 备份数据库，随后仅删除 `host_key='127.0.0.1' AND name GLOB 'dsh-auth-*'` 的 71 行。提交后剩余匹配项为 0，quick_check 正常。

备份在用户 Harness 自己的数据目录：

`C:\Users\Mio\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\Cookies-before-local-auth-cleanup-20261105-222539.sqlite3`

该备份包含认证数据，留在本机，不能提交到项目或上传。

重新启动后观察到 `Assistant_test — DeepSeek Harness` 主窗口。没有回退面板模型代码、修改安装包、删除会话或读取账号密钥。此验证证明清理本机认证 Cookie 能恢复本次启动，不代表面板对话链路本身已经通过功能验收。

## 插件配置恢复

用户此前两次执行内置恢复按钮，产生了两份 patch 备份。第一份 `cordis.patch.yml.bak-1793888235400` 为完整原配置，第二份是第一次恢复后的空配置，不能误用第二份恢复。

恢复前需备份当前 package.json 和 cordis.patch.yml；恢复第一份 patch，并将 package.json 中仍已安装的三个 bundle 加回：dsh-rag-workbench、dsh-desktop-observe、dsh-assistant-host。沿用现有依赖链接，不重新安装组件。

已完成恢复。恢复前备份文件后缀为 `.before-431-restore-20261105-222901`，位于原 profile 目录。恢复后的 bundles 包含原有两个内置项和上述三个本地插件，patch 恢复为 1228 字节。

三个插件恢复后再次启动，仍观察到 `Assistant_test — DeepSeek Harness` 主窗口；最新崩溃日志仍是修复前 14:21:33 UTC 的诊断启动失败，没有新增启动崩溃。未发送模型消息或执行助手面板功能测试。

临时 `results/harness-startup-20261105/netlog.tmp.json` 已删除，只保留本文脱敏结论。Cookie 备份与 profile 恢复备份作为回滚材料留在 Harness 原数据目录。

## 后续边界

本次是现有数据修复，没有修补 Harness 上游的 Cookie 生命周期管理。多次启动后仍可能再次累积。后续可向上游反馈：过期的本机端口认证 Cookie 应清理或改进会话管理；不要通过关闭认证或盲目增大请求头限制掩盖问题。

暂时没有证据说明助手面板接入代码造成这次 431；不要因此推倒主会话连接实现。启动恢复后，面板输入、回复回传和任务隔离需单独验收。
