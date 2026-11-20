# A04 桌面适配决策记录（进行中）

记录日期：2026-10-23。当前暂用 pywinauto 做只读原型；实际指定窗口与同窗低风险动作尚未验证，**不是最终选型结论**。

## 候选核对

| 项目 | 锁定候选 | 核对事实 | 当前处理 |
| --- | --- | --- | --- |
| [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | [PyPI 0.8.8](https://pypi.org/project/windows-mcp/0.8.8/) | MIT；Requires-Python >=3.14；本机 binary-only dry-run 通过，拟新增 91 个包（已装 NumPy 不计）；解析到 FastMCP 4.1.3，不能由可解析推断运行兼容 | 已审查发布 wheel 与依赖，不安装、不启动 |
| [pywinauto](https://github.com/pywinauto/pywinauto) | [PyPI 0.6.9](https://pypi.org/project/pywinauto/0.6.9/) | BSD-3-Clause；当前环境解析为 pywinauto、comtypes、pywin32、six 共 4 个包；无 CUDA/模型依赖 | 按哈希锁安装，导入和 UIA 初始化成功，先验证有界只读接口 |

Windows-MCP 发布 wheel SHA256：`597ef720e1902ba76510a4d2b946949f8a48f281dd210c183de5ded60ea3b873`。

pywinauto 发布 wheel SHA256：`5924b3072864a1d730c5546bbeb17cf4063ba518b618dbc5e43c18276c7c9356`。

Windows-MCP 的现成 Snapshot 提供桌面状态/区域裁剪，工具集合还含 shell、文件、进程、注册表等。发布包 analytics.py 初始化 PostHog 客户端，需单独评估配置和关闭行为。这些是接入约束，不等于项目不能使用；本轮没有运行其服务或遥测。若之后选它，需限制工具暴露范围、验证窗口绑定，并锁定完整运行依赖。

pywinauto 提供 UIA 元素与惰性子节点迭代；本项目只写边界、证据记录和进程超时包装，不重新实现 UIA 底层。MCP 宿主接入尚未实现，不能称为已有可调用的 DSH 桌面工具。

## 依赖安装与隔离

`configs/desktop-pywinauto.lock.txt` 固定 Windows AMD64 / CPython 3.14 的四个包及 wheel SHA256：pywinauto 0.6.9、comtypes 1.4.17、pywin32 312、six 1.17.0。

```powershell
& '.\.venv\Scripts\python.exe' -I -m pip install --require-hashes --only-binary=:all: --disable-pip-version-check --index-url https://pypi.org/simple -r configs\desktop-pywinauto.lock.txt
& '.\.venv\Scripts\python.exe' -I -m pip check
```

只安装到助手 .venv；没有更新 pip 或 NumPy，不动 DSH 配置和 RAG 环境。安装与依赖报告存于 `results/a04/`。报告为当时解析记录，不承诺未来未锁定的依赖组合相同。

## 只读原型

1. `desktop_probe.py list --application calculator` 只导出允许应用的窗口元数据，不读取正文。
2. `observe --application calculator --hwnd <实际句柄> --pid <实际PID>` 绑定同一个可见、非最小化窗口，验证可执行文件名与进程创建时间；观察结束再次核对身份、位置、标题与前台窗口是否变化。
3. 每个快照带 observation_id、窗口身份、采集时间和内容指纹 interface_version；元素编号只在本快照内成立。所有快照 actionable=false，没有动作接口。
4. 最多探测 200 个节点、深度 8、累计文本 6000 字符、单字段 512；子进程总时限 15 秒，内部采集时限 12 秒。超时终止采集子进程，结果保留 unknown。
5. 先检查进程、密码标记与可见状态，再读取文本；密码控件或安全属性不可读时跳过整个子树。Edit/Document 的 TextPattern 读取请求有字符上限。
6. 每轮写入 `runtime/events.sqlite3`，快照与 JSONL 保存到独立 `results/desktop/<批次>/`，记录快照 SHA256。一次工具读取完成不会自动写业务成功。

当前支持直接由 CalculatorApp.exe/Calculator.exe/Notepad.exe 拥有的窗口，以及由 ApplicationFrameHost 承载且能唯一匹配允许内容进程的 Windows.UI.Core.CoreWindow 子窗口。先按宿主/内容 PID、可执行文件名和子窗口类绑定，再读取标题；仅有相同标题不能通过。快照记录宿主与内容句柄/PID/创建时间，UIA 只遍历内容窗口。

本机实际计算器是上述宿主形式，已观察到宿主与内容 PID 不同。直接 OpenProcess 查询在当前工具子进程中被拒绝；固定 Get-Process 元数据查询改为优先使用 PATH 中的 PowerShell 7，缺失时使用系统 Windows PowerShell。它只查询允许的应用与宿主进程，不执行用户提供的命令。没有可用元数据时返回 NO_ALLOWED_PROCESS_METADATA，不能推断应用未运行。

2026-10-23 真机尝试的执行限制：外层 PowerShell 可读取计算器 PID 5220 的元数据和宿主窗口 198966；Python 内启动的 PowerShell 对相同 PID 报告 Cannot find a process。该结果只证明本次工具执行链存在可见性差异，尚未确定系统层原因。不得靠请求管理员权限或修改系统安全设置来消除它。已请用户在 PyCharm 的普通终端运行同一 list 命令复核；未保存计算器控件正文或声称识别通过。

UIA 的可见属性不证明窗口没有被遮挡，树遍历也不是原子操作；指纹只用于观测版本记录，不授权未来动作。跨进程子树被跳过；有限快照不宣称整个应用所有内容。只读阶段不截屏、不读剪贴板、不切焦点、不点击、不输入。

## 验收与待办

当前证据：依赖安装、UIA 初始化、29 项本地模拟测试（含7项宿主绑定/诊断检查）及 pip check。测试日志为 `results/a04/tests-2026-10-23.txt`。真机列表尝试受上述子进程可见性限制，没有完成控件快照；尚无真实窗口成功率、低风险动作或两候选同窗性能比较，这阶段不作效果排序。

下一步先完成指定计算器的只读观测，并由用户核对显示值及控件；再验证新建记事本的虚构测试文本。只读验证完成后才做同窗低风险动作并补齐 A04 验收，随后扩展 B01/B02。
