# 受限只读会话入口（0.4.1）

## 当前验证方式（2026-10-25）

用户已授权后续小规模验证继续进行，不再计算费用或逐轮申请预算。新试验使用 `authorization_mode: small_readonly_validation`，并记录授权来源；不设置金额和价格快照。仍先复核发送图片，绑定会话和图像哈希，限制最多 3 次请求、每次最多 1024 输出 token、有效期及超时。旧试验保持关闭。下文费用推导仅记录旧模式，不适用于当前小规模验证。

记事本新样本已通过通用链路的文字、菜单中心和 JSON 结构复核，结果见 results/b01/readonly-ba41dd30-c2a1-4a8f-98b4-e28d88146db4/evaluation.json。当前没有鼠标键盘执行能力的验收结论，保存坐标仍不可直接用于动作。

草案命令增加 `--bounded-validation` 即可选择此模式；草案仍不会自行启用或跳过图片复核。真实回答经过 `desktop_recognition_result.mjs` 严格结构检查，不自动修补损坏的 JSON，合法坐标也不直接获得动作权限。小窗口样本视觉复核三点命中，但因多余结尾括号记为 partial；见 results/b01/readonly-2cd471b9-10c2-4f33-b747-0ce59cc55c58/evaluation.json。

2026-10-24。0.4.1 的 `/desktop-offline` 已由用户确认有候选且结果可见，并核对到真实父会话回执；现场离线链路通过。归档见 `results/host-session-check/20261024-150443-offline.json`。真实模型选择工具及在线识别未验收。此前 0.4.0 的参数命令曾进入普通聊天，相关缺陷已修复。

后续实测：已在批准的 ¥6.40 / 3 次上限内执行 2 次真实请求，Flash 选择观察工具、接收批准图并返回识别结果。C、7、= 三个中心命中；存在两处表述问题，评价 partial。入口是 Codex CLI 调用插件同一 worker launcher，并非实际宿主在线命令，后者仍未测。证据见 `results/b01/readonly-954f7af6-5114-4a89-9488-16935d48ee73/evaluation.json`。本轮已关闭，不再消耗余量。

## 下次重启后的用法

- `/desktop-trial`：仅查看配置状态，不启动模型或截图。
- `/desktop-offline`：推荐入口。输入完整命令后从候选列表点击，不加空格参数。在隔离进程用旧开发图和本地响应自检；不读取密钥、不调用 API、不采新图。候选未出现时不要发送普通聊天，先检查插件版本。离线自检不要求批准在线预算。
- `/desktop-trial run`：运行已启用、绑定当前会话且在有效期内的一轮验证；已完成的试验不能重复运行。小规模验证沿用上述用户授权，不再逐轮申请预算。

原有 `/desktop-check` 保留。无需重新安装依赖；本地链接插件依赖本项目 scripts 目录，不能只复制插件文件夹单独运行。入口不改共享模型路由、RAG 或全局图片开关。

`/desktop-trial` 现已声明 input.hint；客户端会把它及尾随参数接管到命令输入区，空参数提交为状态查看。旧 `/desktop-trial offline` 写法在 0.4.1 也被接管，但以无参数 `/desktop-offline` 为验收入口。上述本地约束只适用于正确分派到命令的输入，不能约束普通聊天的 API 调用。

## 具体范围

这是 Harness 命令启动的独立受限会话，不向原聊天的模型请求注入拦截器。子进程不加载用户 profile，使用已安装 SDK；批准后才读取既有官方 API 凭据。结果作为命令结果返回，不伪造聊天消息。

只允许一张预先人工确认的已保存截图。验证原图哈希后，用原生附件服务转换并固定实际发送字节哈希；模型通过只读观察工具取得它。工具不重新截屏，不允许改选区域或显示器。结果代表保存时的观察，不能宣称是当前状态，也不能直接用于点击。

固定问题要求识别应用、可见文本、遮挡、目标中心和不确定性，坐标相对于附件像素。没有鼠标键盘工具、搜索或文件上传，不加载其他会话历史。真实模型选择工具的行为仍需在线检验。

## 费用依据

本次核对的官方价格为：Flash 上下文 1M，高峰输入未命中缓存每百万 token ¥2，输出 ¥8。离线用量计算属于估算，当前 16000 非图片字节限制不能作为精确 token 上限。

使用整个上下文作为保守输入上界，将 1M 向上取为 1,048,576 token，再额外预留输出 1024 token，不扣除输出在上下文内的占用：

`每次 = (1,048,576 × 2 + 1024 × 8) / 1,000,000 = ¥2.105344`

`最多 3 次 = ¥6.316032`

这是供应商遵守已公布上下文、max_tokens 和计费规则时的保守上界，**不是预计消费或已批准额度**。不考虑缓存或空闲折扣；字节、图片和输出限制仍同时执行，失败和重试也占次数。价格核对记录 24 小时后失效，需重新核对。

来源：[官方模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[官方 Token 用量说明](https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/)。此前 ¥0.50 试验已关闭。新配置预算为 0；采用本策略时需另行批准覆盖上述上界的预算，例如 ¥6.40。准备好具体截图、会话和有效期后再申请批准。

`desktop_session_plan.mjs` 负责推导费用及检查价格、批准。通用 `desktop_wire_guard.mjs` 自身不证明任意调用方的预留值，故通用账本仍有 monetary_bound_verified=false；本入口在外层强制使用上述上界，并在报告 monetary_bound 字段保留依据。

## 配置和记录

`configs/desktop-session-trial.json` 需要新试验标识、批准状态、预算、父会话 ID、未来 30 分钟内的失效时间、已确认截图的 observation.json 路径和 SHA-256。每次发送前重新检查原配置哈希与有效期；修改、取消或到期后不再发送。

`scripts/prepare_desktop_session.mjs --observation=绝对路径 --session=会话ID` 可为 15 分钟内的新截图生成独立 plan.json / review.json 草案，校验原图哈希与几何信息。草案放在 results/proposals，不修改运行配置；approved、image_reviewed 均为 false，预算为 0。准备截图不等于用户批准发送。当前会话 ID 可从 `/desktop-trial` 状态结果取得。

`results/b01/<trial_id>/run.lock` 在读取凭据前独占创建，同一试验只能启动一次。失败、取消、崩溃也不自动删除锁重跑。ledger 中先持久化预留再发送；result.json 保存模型文本、usage、映射和配额摘要，不代表识别准确性通过。

正常结束与 IPC 取消会清理临时副本、附件库。取消等待 3 秒后仍不退出才强制终止；此时可能遗留临时目录，提示核对，不自动退次数。正式证据、原图、账本和锁保留。

## 验证

0.4.1 增加客户端入口验证：`scripts/check_dsh_composer_dispatch.mjs` 提取已安装 client.js 的 matchEnter、dispatch、leadingClaim 原方法体，用原生命令目录验证。旧缺少 input 的描述符确实返回 undefined（交由普通聊天），修复后旧参数写法得到 claim，新命令菜单点击和裸命令回车均被 handled。服务与窗口为夹具，未冒充现场 UI 测试。报告 `results/a04/dsh-composer-dispatch.json`。新命令也通过真实隔离子进程检查，14 项相关单元测试通过。

19 项相关单元测试通过（含 2 项草案准备检查）；原生命令→实际子进程链路通过；未批准 run 被阻止；IPC 取消与临时清理通过。报告为 `results/a04/dsh-session-command-offline.json`、`results/a04/dsh-session-worker-offline.json`。本轮付费请求、新截图、桌面操作均为 0，实际宿主与真实识别待验收。
