# 桌面组件源码检查（2026-10-23）

本次只读检查本地源码与在线上游文件，没有执行第三方代码、安装依赖、启动插件、捕获屏幕或调用模型。

## 用户已下载的组件

| 项目 | 本地源码 | 清单声明版本 | 检查结果 |
| --- | --- | --- | --- |
| Windows-MCP | `third_party/sources/Windows-MCP-main/` | 0.8.8 | ZIP 内 186 个文件与解压内容逐文件 SHA-256 一致 |
| DSH Vision Toolkit | `third_party/sources/dsh-vision-toolkit-main/` | 0.1.47 | ZIP 内 335 个文件与解压内容逐文件 SHA-256 一致 |

压缩包 SHA-256（用于后续复核本次下载，不代表已核对发布者签名）：

```text
Windows-MCP-main.zip
5d204637b562f0e4509f046d68cafe012cd50aca625c7a68f23f3978304c5b78
dsh-vision-toolkit-main.zip
98f24525cf371929831b0264c5a192bfc33e7e4332b520a1a398ce9952abdd1f
```

- Windows-MCP 要求 Python >=3.14，项目现有 3.14.9 满足最低版本。`src/windows_mcp/tools/snapshot.py` 的 Screenshot 明确设置 `use_ui_tree=False`；可选择仅开放 Screenshot，无需按计算器进程名识别。尚未验证本机运行。
- Vision Toolkit 的 package.json 明确将 DSH 0.2.1-rc.2 列为 compatible；这是作者声明，本机兼容性仍待验证。源码 ZIP 带有 lib、src、运行时材料及依赖清单。
- Vision Toolkit 的桌面中文安装指南仍举 0.1.34 为例，落后于此次源码 0.1.47，不能照抄旧版本号。

## dsh-orb-cordis 候选

后续本地检查：用户提供的 `dsh-orb-cordis-main.zip` SHA-256 为 `491b8c5476a02c3617582d2d4afd3f9822f2244766304ed08850aefb57c2d9d2`。151 个文件与解压内容逐项一致，但包内缺少 `packages/computer-use/package.json`、`src/plugin.ts`、`src/config.ts`、`packages/bundle/package.json` 等构建文件。因此不是解压漏文件，当前只能把已有源码作为局部参考；不能将下述在线源码信息视为本地完整副本或已安装版本。

作者仓库：https://github.com/mini-yifan/dsh-orb-cordis

仓库名为 dsh-orb-cordis；安装包名为 dsh-orb。在线 main 分支 `packages/bundle/package.json` 声明 0.1.9（未核验 npm 当前发布版本）。支持 Windows x64；包声明与多项 DSH 内部组件的 peerDependencies 范围为 `>=0.1.7-rc.2 <0.3.0-0`，不能仅凭范围文字断言当前预发布宿主可安装。

已读到的实现：

- `packages/computer-use/src/windows.ts`：通过 koffi 接 Win32，GDI 截图与 SendInput 输入；坐标与观测使用物理像素。没有依赖 Python 或 CUDA 的这条实现路径。
- `packages/computer-use/src/index.ts`：导出 DesktopBackend、createPlatformBackend 等接口，存在复用工具层的入口；独立拆出仍需适配。
- `packages/computer-use/src/plugin.ts`：首轮图像与动作后观测接入 DSH 事件；截图、坐标和前台窗口信息进入工具结果。
- `packages/computer-use/src/route.ts`：要求当前模型路由显式声明 image 输入，不满足会拒绝 GUI 工具。因此不能将其视为给任意文本模型自动增加视觉能力的插件；与 Vision Toolkit 透明路由能否配合仍需测试。
- `packages/bundle/cordis.patch.yml`：安装 Computer Use preset、后台 code_agent、悬浮球 host 和设置页；host autoStart=true。它提供整套交互入口，超出单独输入工具的职责。
- Windows 观测主要围绕前台应用窗口；是否满足全桌面、多窗口和多屏需求仍需单独验收。

当前需要区别的行为：

- README 声明 GUI 工具不逐次询问，安装视为授权；Access 芯片描述不能直接当作 GUI 只读保证。尚未完成全部权限路径审计。
- 首次使用会下载独立 Electron helper，并校验预置哈希；不是只有源码 ZIP 即可运行。
- 名为 screenshot 的显式工具会保存到桌面并复制到剪贴板，和内部自动观测不同。
- 尚未验证人工输入抢占、失效观测拒绝、取消中途的按键/鼠标释放及任务完成判定。

主要在线来源：

- https://github.com/mini-yifan/dsh-orb-cordis/blob/main/packages/bundle/package.json
- https://github.com/mini-yifan/dsh-orb-cordis/blob/main/packages/bundle/cordis.patch.yml
- https://github.com/mini-yifan/dsh-orb-cordis/blob/main/packages/computer-use/src/windows.ts
- https://github.com/mini-yifan/dsh-orb-cordis/blob/main/packages/computer-use/src/route.ts
- https://github.com/mini-yifan/dsh-orb-cordis/blob/main/README.md

## 当前建议

Orb 值得下载源码作为 Harness 原生视觉操作候选；沿用 downloads/ 保存 ZIP、sources/ 解压。源码 ZIP 只用于检查，仓库根包是 private monorepo，不能直接当作可安装 bundle。正式安装需核验发布包或按作者说明构建。

当前只读阶段，Windows-MCP 的工具白名单更容易限定为截图。Orb 若在本机通过模型路由、坐标和权限验收，可成为面向用户的操作入口；与 Windows-MCP 选择一套主执行器，避免重复派发输入。Vision Toolkit 保留为按需视觉工具，是否成为 Orb 的必需组件取决于模型路由验证结果。
