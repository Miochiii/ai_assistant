# 第三方开源组件下载区

核对日期：2026-10-23。当前仅准备源码下载位置，尚未安装或接入以下组件。

## 目录用途

- `downloads/`：手动下载的原始 ZIP 压缩包，保留原始文件名。
- `sources/`：解压后的完整项目源码，每个项目单独一个目录。
- 本目录不存放 API 密钥、桌面截图或运行日志。项目自己的实现仍放在根目录 `src/`。

建议布局（项目源码目录待用户下载后产生）：

```text
third_party/
  README.md
  downloads/
  sources/
    dsh-vision-toolkit/
    Windows-MCP/
    agent-vision-toolkit/  # 可选，只供参考
```

## 本轮候选

| 优先级 | 项目 | 用途 | 当前上游信息 |
| --- | --- | --- | --- |
| 首选 | [DSH Vision Toolkit](https://github.com/Anionex/dsh-vision-toolkit) | Harness 原生视觉插件；图像理解、OCR、目标定位和标注预览 | main 分支 package.json 声明 0.1.47；Node 要求 ^22.19.0 或 >=24.0.0 |
| 首选 | [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | Windows 截图、坐标点击和键盘操作；支持选择开放的工具 | main 分支 pyproject.toml 声明 0.8.8；Python >=3.14 |
| 可选 | [agent-vision-toolkit](https://github.com/Anionex/agent-vision-toolkit) | 上述 DSH 插件的上游视觉工具方案，用于研究和二次开发 | 与 DSH 插件用途重叠，当前无需重复部署 |

版本号来自核对时的源码清单，不代表已验证兼容当前 Harness，也不是已经固定的 Release 或提交。安装前将检查实际下载内容、提交/标签、依赖和接口兼容性，再确定锁定版本。Python 3.14.9 满足 Windows-MCP 声明的最低版本，完整运行兼容性仍待测试。

来源：

- https://github.com/Anionex/dsh-vision-toolkit/blob/main/package.json
- https://github.com/Anionex/dsh-vision-toolkit/blob/main/README.md
- https://github.com/CursorTouch/Windows-MCP/blob/main/pyproject.toml
- https://github.com/CursorTouch/Windows-MCP/blob/main/README.md

## 手动下载方式

先下载两个首选项目即可。在 GitHub 项目页选择 Code → Download ZIP，将 ZIP 保存到 `downloads/`，再解压至 `sources/`。解压后保留 `-main` 后缀也可以，不必为对齐示例改名。请保留完整项目结构和许可证。

本轮只下载源码，不执行仓库安装、自启动或模型测试命令；不需要下载模型权重或 CUDA。源码下载本身不消耗模型 API 额度，后续视觉模型调用的费用与部署方式另行确认。

## 试验路线

目标闭环：Windows 截图 → 视觉定位 → 坐标映射 → 单步输入 → 新截图核验。按当前阶段先验证截图及目标定位，随后再测试操作。计算器和记事本是验收样本；接口应能处理不同窗口位置和尺寸，不依赖各应用的专用进程名或控件表。

DSH Vision Toolkit 本身需要配置视觉模型；它不是随源码附带的本地视觉模型。Windows-MCP 也包含 UIA 和其他系统工具，本项目拟优先复用它的 Screenshot 与坐标输入能力；只读阶段先仅开放 Screenshot。接入后仍须验证截图尺寸、屏幕缩放与点击坐标的一致性。

[DSH Computer Use](https://github.com/Anionex/dsh-computer-use) 当前要求 macOS 14+，不列入本 Windows 项目的下载清单。
