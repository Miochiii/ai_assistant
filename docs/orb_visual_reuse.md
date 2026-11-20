# Orb 视觉链路复用审阅

日期：2026-10-23。只读源码审阅，未安装 Orb、未调用模型、未改变已加载的截图插件。

## 结论

优先复用 Harness 当前 Flash 的原生图片输入通道；Vision Toolkit 不再是首轮必装项。Orb 本身通过 Harness 附件服务把截图提供给当前模型，并不要求额外视觉服务。

本机 `E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js` 默认模型目录（约 42–49 行）声明：

```json
{"id":"deepseek-flash","name":"DeepSeek-V4.1-Flash","inputModalities":["text","image"]}
```

同文件 `prepareImages`（约 1427–1430 行）检查图像能力和附件服务，接受用户消息及工具结果中的图片。本次未调用远程模型目录，未验证具体会话路由覆盖或服务端 1017 快照；不能由别名推断精确服务端版本。

## Orb 可复用的设计

| 环节 | 源码证据 | 本项目采用方式 |
| --- | --- | --- |
| 沿用模型 | 本地 `packages/host/src/model-defaults.ts`，`preferences.ts` | 跟随 Harness 的当前会话模型与凭据；不另外索取 API key，不修改全局默认模型 |
| 能力检查 | 上游 `packages/computer-use/src/route.ts` | 从会话请求配置解析 provider/model，检查解析后的 `inputModalities`；不能只凭显示名称判断 |
| 持久图片附件 | 上游 `packages/computer-use/src/observe.ts` 的 `observeDesktop` | 将已校验截图字节交给 `ctx.attachments.saveImage`，保留附件实际尺寸 |
| 模型可见图片 | 同文件 `observationBlocks` | 工具返回文字元数据与 `{type:'image', attachment:...}`；仅返回路径不等于模型已收到图片 |
| 坐标约定 | 同文件 `formatScreenEnvelope`；本地 `tests/tools.spec.ts` | 固定使用一种坐标制。本项目已有像素映射，优先使用附件实际图像像素，并保留截图的桌面原点与原始尺寸 |
| 每步新观测 | 上游 `plugin.ts` 的 `recapture`、`rememberObservation` | 后续输入阶段每次动作后重新采集，避免旧坐标跨画面复用；当前仅只读 |

Orb 既有 0–1000 归一化坐标，也有像素模式。它的前台窗口采集范围与本项目的显示器/显式裁剪范围不同；复用附件和坐标契约，不照搬其前台窗口选择。底层 GDI 截图代码可供参考，目前 MSS 截图已经验证，无需为了图片传递重换后端。

Orb 还会在用户轮次前自动附加首帧，并包含输入工具、桌面截图文件及剪贴板行为。本项目维持显式只读工具调用，不引入自动首帧、剪贴板写入或操作权限。

## 当前缺口及实施顺序

实施更新：0.2.0 已完成下列第 1、2 项的离线实现与检查，14 项 Node 测试通过，真实 Harness 附件服务的缩放与读回通过。没有模型请求，当前图片开关关闭。第 3、4 项仍待执行；详见 `../plugins/dsh-desktop-observe/README.md`。

1. 现有 `desktop_observe` 只返回 JSON 和本地路径。保持已加载版本行为不变，先离线实现附件保存与图片内容块渲染，并检查 DSH 实际附件接口。
2. 用模拟模型/禁止联网的测试验证：同一张截图能形成有效图片内容块；附件被缩放后仍可按实际尺寸映射；纯文本路由被拒绝；不会在加载插件时截图或发请求。
3. 实际发送前确认当前会话的 Flash 路由与费用来源。给用户具体调用次数、输出上限和总预算，再启动只读识别；不得将账号路由误认为免费。
4. 先读出计算器状态并标记按钮位置，独立核对；通过前不开放点击。

本轮只审阅，没有复制上游源码。若后续直接移植文件，先补查对应提交和许可证。用户 ZIP 的 computer-use/src 缺少 route.ts、observe.ts、plugin.ts 等文件，已在线阅读作者仓库对应文件；在线 main 可能与本地 ZIP 版本不同，不能声称已验证本地完整构建。

## 上游来源

- https://github.com/mini-yifan/dsh-orb-cordis/blob/main/packages/computer-use/src/route.ts
- https://github.com/mini-yifan/dsh-orb-cordis/blob/main/packages/computer-use/src/observe.ts
- https://github.com/mini-yifan/dsh-orb-cordis/blob/main/packages/computer-use/src/plugin.ts

说明：本机默认模型目录与图片处理实现是本机检查结果；上游源码说明 Orb 的接口设计；二者均不能代替真实模型识别验收。
