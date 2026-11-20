# Harness 会话循环验证

2026-10-24。此记录对应本机 DSH 0.2.1-rc.2 的原生 AgentLoop、SessionStore、ToolRuntime、LlmRuntime 和附件服务；没有启动付费模型或访问当前桌面。

## 已验证的路径

`scripts/check_dsh_agent_loop.mjs` 创建隔离的内存会话，只注册本地确定性模型适配器。第一轮模拟响应请求 `desktop_observe`，真实工具调度执行项目的图片传递代码，真实附件服务处理已有开发截图，工具结果进入会话历史；第二轮模拟适配器检查收到的图片引用与附件回执完全一致，再返回模拟文本。会话会正常结束。

截屏函数以已有图片夹具替代；图片开关使用该脚本内的依赖注入，项目 `configs/desktop-observe.json` 保持关闭。没有读取 API 凭据、加载用户 profile、连接运行中桌面宿主或使用真实模型。模拟响应与中心坐标是协议测试数据，不计入视觉识别准确率。

报告：`results/a04/dsh-agent-loop-offline.json`。

| 情况 | 检查结果 |
| --- | --- |
| 正常图片传递 | 一次工具调用、两轮模拟请求；下一轮含同一个图片附件，缩放后的中心正确映射至原桌面 |
| 图片开关关闭 | 截屏夹具未执行，下一轮不含图片 |
| 图片哈希不匹配 | 图片传递被拒绝，下一轮不含图片 |
| 模拟模型不断调用工具 | 限定两轮后，第三轮在适配器执行前被拒绝，会话结束 |
| 工具执行时取消 | 只发生第一轮模拟请求，不再发起下一轮 |

## 会话请求限制

`plugins/dsh-desktop-observe/request-limit.js` 提供按 session_id 绑定的 `llm/stream` 拦截器。它限定路由、逻辑请求数、maxTokens 和请求对象的序列化字节数；失败尝试也消耗次数，同一会话的标题请求共用次数。其他会话不受影响。并发预留同步完成，超额请求在适配器执行前拒绝。

这只是会话内的逻辑请求限制，**不是已验证的人民币费用硬上限**：序列化字节不等于供应商 token，适配器内部 HTTP、文件上传与内部重试需要在实际发送边界另行核对。当前限额仅保存在进程内，不跨重启延续。尚未在插件 `apply()` 中启用，重启 Harness 不会自动启用它或开始实验。

3 项单元测试覆盖失败及标题计数、路由/输出/体积拒绝、取消、并发上限与会话隔离；完整原生循环另有上述 5 个集成案例。

## 复现与清理

使用本机 Harness Electron 的 Node 模式运行脚本（PowerShell）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'E:\dsh\DeepSeek Harness.exe' --expose-internals -e 'import("file:///E:/file/agent/ai%20assistant/scripts/check_dsh_agent_loop.mjs").catch(e=>{console.error(e.message);process.exitCode=1})' | Out-String
```

临时图片、附件库在项目 `results/vision/tmp-agent-loop-*` 内创建；先释放会话与服务，再校验绝对路径位于该证据目录内并清理。原始截图和最终报告保留。

后续已补充原生 DeepSeek SDK 的实际请求正文与持久配额离线检查，见 [发送边界验证](desktop_wire_validation.md)。两个脚本均已改用原生 createUserMessage，原有 5 个案例重跑通过。费用硬上限和实际宿主接入仍待完成；此前 ¥0.50 试验已关闭，不因离线检查重新启用。鼠标键盘操作尚未接入。
