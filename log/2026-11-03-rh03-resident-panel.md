# RH03 常驻面板落地记录

日期：2026-11-03  
性质：实现记录；本阶段不接真实模型、不截屏、不发送桌面输入。

> 2026-11-03 更新：界面已由后续 `2026-11-03-resident-compact-ui-update.md` / `2026-11-03-resident-blue-pink-glass.md` 的紧凑蓝粉玻璃版替代。该版本不再创建独立鲸鱼窗；面板与消息 feed 两个窗口的 WDA 均为 `0x11`，mss `--exclude-capture` 截图已确认不包含助手窗口。本文保留旧大面板过程记录，以 final `rh03-resident-panel.json` 和 compact 文档为准。

## 完成内容

在 RH01–RH02 离线 Host 上增加：

```text
tools/coach_overlay/resident_panel.py
tools/coach_overlay/resident_channel.py
plugins/dsh-assistant-host/ui-process.js
scripts/run_resident_ui_demo.mjs
```

并保留旧入口：

- `tools/coach_overlay/coach_overlay.py` 的静态/preview/host-paced 行为未改
- `tools/coach_overlay/coach_host.py` 未改
- 原布局测试可继续运行

## 界面行为

- 无任务时鲸鱼和聊天面板都保留
- 鲸鱼气泡显示“待命中 · 随时可以聊”
- 鲸鱼按钮显示“聊一聊”，点击聚焦聊天输入框
- 有任务时：
  - 气泡显示当前步骤
  - 鲸鱼按钮显示“检查”
  - 主高亮层仍保持隐藏/穿透（本阶段没有目标框）
- 面板是正常的可聚焦 Tk Toplevel；鲸鱼/Next/Close 仍是不透明独立小窗
- 面板包含：
  - 历史文本
  - 单行输入、发送
  - 检查当前步骤
  - 跳过（未验证）
  - 暂停/恢复观察
  - 演示任务 A/B
  - 关闭
- 输入框通过 `KeyPress` 发送 `typing_started`，900ms 后发送 `typing_ended`
- 关闭按钮/标题栏发送 `close_assistant`，等待 Host state 变 closed 后退出
- 面板默认位于右上；鲸鱼位于右下
- 面板、鲸鱼、按钮都请求 capture exclusion（若启用）
- **实测发现：**`--exclude-capture` 下鲸鱼/按钮的 `GetWindowDisplayAffinity` 为 `0x11`，但聊天面板仍为 `0x0`；mss 截图仍包含聊天面板。聊天面板的 WDA 设置失败/未生效，RH04 前必须解决。
- 面板、鲸鱼、按钮没有接收目标应用输入

## Node UI 进程

`ui-process.js`：

- 启动 `E:\python\python.exe tools/coach_overlay/resident_panel.py --channel-dir ...`
- 等待 `ui-ready.json`
- 读取 `ui-heartbeat.json`
- `stop()` 等待 exit（Windows 下 signalCode 也视为已停止）
- 不自动启动，不注册工具，不接入模型

## 实测

本地 demo：

```text
node scripts/run_resident_ui_demo.mjs
```

截图：

- 待命/聊天面板/鲸鱼：`results/vision/resident-ui-step1c.png`
- 任务 A + 离线聊天回复：`results/vision/resident-ui-task-chat.png`

已验证：

- Python Tk 面板和鲸鱼同时出现
- 无任务待命，面板不消失
- 任务 A 状态显示为 `STEP 1/2 · waiting_user`
- 气泡显示“点击‘新会话’”，按钮变“检查”
- 通过 channel 提交 `start_task` 和 `chat_submit`，Node Host 写入 outbox，面板显示回复
- 通过 channel 提交 `close_assistant`，state 变为 `closed`，UI 进程退出
- 关闭后 Node demo、Node Host、Python/Tk 面板均无残留（复测）
- 焦点探测：固定执行器点击聊天输入框后出现 caret；`GetGUIThreadInfo` 返回 Tk 顶层容器（Tk 的键盘路由在顶层内部），真实键盘输入/IME 仍未验证
- Node UI process 测试：handshake、heartbeat、stop、缺失 handshake 拒绝
- Node tests：17 个 Host/协议/生命周期 + 2 个 UI process = 19 passed

## 尚未完成/未验证

- **输入框真实键盘输入和 IME**没有用当前桌面执行器自动化验证；只验证了面板可聚焦和事件通道。
- “检查/跳过”按钮是 UI 事件，不改变旧 Coach 的验证语义；步骤结果验证仍属于 RH06。
- 没有真实模型、截屏、ffmpeg、OCR、观察循环。
- 没有安装新插件；`/assistant-check` 仍只做离线自检。
- 面板/鲸鱼的 screenshot exclusion 只在代码中请求，未做端到端捕获后端复验。
- **聊天面板 WDA 实测失败**：鲸鱼/按钮为 `0x11`，面板为 `0x0`，mss 仍截到面板；这是 RH04 的硬前置。

## 下一步

RH03 剩余验收：

1. 用真实键盘输入验证 Entry 焦点和中文 IME
2. 关闭后确认 Node/Python/Tk 无残留
3. 用截图/桌面工具验证面板、鲸鱼、按钮不被 Host 捕获
4. 接一个 mock/fake model 的可视回复，确认连续两条消息与任务切换
5. 之后再进入 RH04 持续观察

RH04 之前不要启动持续截屏或 See Now 采集循环。
