# 原生 SDK 发送边界验证

2026-10-24，本机 DSH 0.2.1-rc.2。此阶段全部离线，没有新的识别成绩或 API 消费。

## 已实现

`scripts/desktop_wire_guard.mjs` 在传输调用前校验官方 Messages 端点、POST、禁止重定向、会话标识、Flash 模型、关闭思考、输出上限、请求体及非图片内容字节数。支持原生 tool_use / tool_result 历史，只允许两个只读桌面工具；单张内联图片必须匹配预先固定的实际发送字节 SHA-256。独立 Files 上传、URL 图片和未知内容类型在发送前拒绝。

每次请求先独占创建 request-N.json 并 sync，再交给传输函数。失败、取消和重试都不退还次数；重新创建限制器继续使用原目录的配额。策略指纹固定试验、会话、次数、图片和限制，不能通过修改参数扩大同一账本的额度。每次发送重新读取批准状态；关闭批准、账本损坏或写入失败时拒绝继续。账本只保存次数、哈希、大小和预留值，不保存密钥、请求正文或图片 base64。

并发碰到尚未写完的记录时也会保守拒绝，可能少用配额；没有自动清理或重建坏账本的逻辑。调用方必须沿用同一账本目录，不能删除账本或新建试验目录来恢复已使用的次数。本模块不是操作系统级网络沙箱。

## 原生链路结果

`scripts/check_dsh_wire_loop.mjs` 使用真实 AgentLoop、ToolRuntime、附件服务、DeepSeekAdapter 序列化和 SSE 解析，HTTP 响应由本地夹具提供：

1. 第一轮发送两项只读工具定义，本地响应请求 desktop_observe。
2. 工具返回已准备的旧截图附件，下一轮 Messages 正文包含同一图片的 base64，哈希匹配。
3. 本地响应返回固定结束文本，原生会话正常结束。
4. 重新创建限制器后再尝试请求，被已耗尽的两次配额拒绝。

两轮非图片正文分别为 1552、4659 字节，输出上限均为 1024 token。SDK 尝试一次文件解析，在依赖注入处拒绝后切到其原生内联图片回退；没有发生文件上传。原生图片计数为 197 token。图片在循环前用原生附件服务准备并固定哈希，截屏函数使用既有开发图；这里没有验证现场截图与在线识别。

同时发现此前自定义模型夹具容忍了缺少 role 的用户消息。两个循环脚本现均使用 SDK 的 createUserMessage；旧的 5 个循环案例重新运行通过。新增 5 项发送限制测试通过，另有 3 项逻辑会话限制测试通过。

报告：`results/a04/dsh-native-wire-offline.json`。脚本没有在线模式，明确拒绝 `--send`，不读取 profile 或凭据。临时账本、图片副本和附件目录会在 finally 中校验目录归属后清理；报告保留经过脱敏的账本摘要。

## 尚未完成

后续更新：0.4.0 已实现隔离会话入口，并按官方完整上下文上界推导保守费用预留，见 [受限会话入口](restricted_session_entry.md)。新配置未批准，实际宿主和在线识别待验收；以下记录本阶段完成时的限制。

人民币费用硬上限仍未验证。reserveMicroCny / budgetMicroCny 当前用于验证预留账本运算，夹具数值不是新的预算批准，也不是经 token 计数证实的最高账单。非图片字节数不能直接等同于输入 token；报告明确记录 monetary_bound_verified=false。上线前仍需完成输入 token 上界和届时价格核对，并绑定新的具体批准。

已安装 SDK 的 Messages 使用全局 fetch，因此本验证只在独立 Electron Node 进程替换 fetch，未向共享 Harness 宿主安装全局拦截器。实际插件入口仍未挂接该限制器；重启也不会自动开启图片或试验。后续需要将受限会话放入隔离工作进程，再把结果返回 Harness，或找到不影响其他会话的原生传输扩展点。RAG 与运行中宿主保持原状。

## 复现

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'E:\dsh\DeepSeek Harness.exe' --expose-internals -e 'import("file:///E:/file/agent/ai%20assistant/scripts/check_dsh_wire_loop.mjs").catch(e=>{console.error(e.message);process.exitCode=1})' | Out-String
```
