# A01 本机运行入口与依赖边界

核对日期：2026-10-22（北京时间）。本任务完成环境盘点；不代表桌面组件兼容性、DSH 新工具接入或窗口识别已经通过。

2026-10-23 更新：用户安装 NumPy 2.5.4 后已核对包元数据；普通本机权限下 pip list 正常，先前错误仅在受限执行环境复现，不需重建环境。现已按哈希锁安装 pywinauto 0.6.9、comtypes 1.4.17、pywin32 312、six 1.17.0，导入/UIA 初始化与 pip check 通过。以下“仅 pip / 未安装组件”为 A01 当时快照；当前 A04 状态见 `desktop_adapter_decision.md`。

## 1. 当前结论

- 助手项目保留 `E:\file\agent\ai assistant\.venv`：实测 CPython **3.14.9 / AMD64**，不继承系统包，用户 site 禁用，仅安装 pip 25.0.1。用户确认由 PyCharm 创建，`pyvenv.cfg` 记录 virtualenv 20.30.0。
- `00`、`01` 中关于该环境为 3.12.4 的描述属于历史记录，不能作为当前安装依据；也不采用 `00` 中继承全局包的建议。
- DSH 桌面程序实际路径为 `E:\dsh\DeepSeek Harness.exe`；可执行文件和内置包均确认版本 **0.2.1-rc.2**。
- `desktop` profile 的 package.json 和目录联接确认加载源为 `E:\file\agent\plugin\dsh-rag-workbench`（0.10.0）；其 `cordis.patch.yml` 包含 `http://127.0.0.1:8000/mcp`。
- 旧 RAG 默认项目为 `E:\file\agent\python.v\project`，默认解释器为其上一级 `.venv\Scripts\python.exe`，实测 Python **3.12.4**。本次未改动它的代码、配置、依赖或数据。
- 当前 `GET http://127.0.0.1:8000/openapi.json` 返回连接拒绝（WinError 10061），未启动服务，未调用问答、检索、评价或模型 API。

## 2. 进程和运行环境对应关系

| 组件 | 入口与环境 | 本次证据及状态 |
| --- | --- | --- |
| 助手项目脚本 | `E:\file\agent\ai assistant\.venv\Scripts\python.exe` | 实测 3.14.9，基础解释器位于 `C:\Users\Mio\AppData\Local\Python\pythoncore-3.14-64`；尚无助手服务或桌面依赖 |
| DSH Desktop 宿主 | `E:\dsh\DeepSeek Harness.exe` | Get-Process 确认运行中；FileVersion 与 app.asar 中 desktop / desktop-host 包版本均为 0.2.1-rc.2 |
| DSH CLI | `E:\dsh\resources\runtime\cli\bin\dsh.cmd` | 已读取包装脚本；设置 ELECTRON_RUN_AS_NODE 后通过上述 EXE 执行 app.asar 内 desktop-host/lib/cli.js；不是助手 Python，也不依赖 PATH 中的 Node |
| DSH 主运行时 Node | `C:\Users\Mio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` | `--version` 实测 v24.21.0；仅说明此运行时可用，不代表所有 DSH 子进程均由它启动 |
| DSH 主运行时 Python | `C:\Users\Mio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe` | 实测 3.12.14；不用于安装助手桌面组件 |
| RAG 后端（按需启动） | `E:\file\agent\python.v\.venv\Scripts\python.exe -m uvicorn rag_server:app --host 127.0.0.1 --port 8000`，cwd=`E:\file\agent\python.v\project` | 插件 lib/service.js 与 lib/paths.js 的默认解析路径；解释器实测 3.12.4，本轮端口无响应 |
| RAG 记录/评价桥（按需子进程） | 同一 RAG 解释器，执行插件 `scripts/records.py`，cwd 为 RAG 项目 | lib/records.js 确认启动方式；本轮未执行记录/评价操作 |
| RAG 发布副本 | `E:\file\agent\paper_rag_project` | 交付与复现材料，非本机插件默认启动目录 |

RAG 插件允许宿主环境变量 `RAG_WORKBENCH_PROJECT` / `RAG_WORKBENCH_PYTHON` 覆盖默认路径。本次未读取运行中宿主的完整环境，表中不把默认解析冒充当前子进程的实测命令。Get-CimInstance Win32_Process 被系统拒绝，改用 Get-Process 验证可执行文件路径；未获取父子进程完整关系。

## 3. Profile 与启动约束

- profile 目录：`C:\Users\Mio\.dsh\profiles\desktop`。
- package.json 的 `dsh-rag-workbench` 依赖为 `link:E:/file/agent/plugin/dsh-rag-workbench`；node_modules 对应 Junction 指向相同位置。
- `web` profile 也存在，但旧文档中的 web 安装命令不用于本项目。
- 当前结论基于 desktop 配置、联接和宿主版本。未在本轮点击宿主界面确认工具加载状态，也未执行会输出完整配置的命令；新 MCP 的宿主可用性在 A04 单独验证。
- 当前 PowerShell 找不到 `dsh`、`uv` 命令；PATH 中的 Node 来自 `E:\cherry studio\NODE\node.exe`。后续使用明确绝对入口，避免误用其他软件的运行时。
- RAG 的日常启动入口仍为 DSH 内的“启动 RAG 服务”；本项目不接管其启动与停止，不重复启动同一知识库后端。

## 4. 已有接口与复用边界

| 接口/能力 | 已核对来源 | 后续使用边界 |
| --- | --- | --- |
| `http://127.0.0.1:8000/mcp` | desktop patch、RAG app/server.py | 复用已有服务；不把 RAG 依赖搬入助手环境 |
| `GET /openapi.json` | 插件 lib/service.js 的服务识别逻辑 | 本次只做此元数据探测；识别需同时核对 title=rag-server、/search 和 /corpus/list 路由 |
| `POST /search`、`POST /ask` | RAG app/server.py 路由 | 本轮未调用；不能假定 search 永不调用模型，实际接入前核对参数和实现 |
| 回答来源、本地核对、语义评价与近期统计 | 工作台 README、lib/records.js | 保留评价对象为后端 ask 文本；不冒充 DSH 最终改写文本。付费语义评价另按具体批次授权 |

## 5. 桌面组件候选与安装前检查

前一轮已在线核对 [Windows-MCP 官方配置](https://github.com/CursorTouch/Windows-MCP/blob/main/pyproject.toml)：main 当时声明 0.8.8、Python >=3.14；本机解释器满足声明门槛。main 会变化，该信息不是锁定版本，也不能代替本机依赖解析和 UIA 测试。

备选为 [pywinauto](https://github.com/pywinauto/pywinauto)，提供 Win32/UIA 后端。尚未锁定其版本或证明 Python 3.14 兼容。A04 在相同测试窗口比较后只选一个主实现。

安装前须记录发布包/tag/commit、许可证、完整依赖解析结果及 Python 3.14 Windows wheel 可用性；检查启动行为、联网/遥测、后台任务及工具权限。采用项目隔离环境；如某个候选确需不同运行时，先记录理由，再采用独立环境，不更换当前 `.venv`，不碰 RAG 环境。

当前不需要用户下载仓库或模型。未安装 Windows-MCP、pywinauto、CUDA、视觉权重、记忆框架或 QQ 插件；未升级 pip。

安装前待解决：本次执行环境中 `python -I -m pip list --disable-pip-version-check` 失败，堆栈位于 pip 25.0.1 内置 platformdirs 读取 `CSIDL_COMMON_APPDATA` 注册表值，报 FileNotFoundError / WinError 2。尚不能归因为 Python 版本或用户系统故障，也未验证是否仅在当前受限执行环境出现。包清单由标准库 importlib.metadata 成功读取；安装前应先确认 pip 的可用执行方式，不因此重建虚拟环境或修改注册表。

## 6. 首批测试边界

- 用户已确认计算器、记事本能正常开启；尚未确认此刻指定窗口已经打开，也未采集屏幕或控件内容。
- 顺序为 A02 场景及失败分类 → A03 事件记录 → A04 适配 → B01 只读识别。
- 第一轮只读当前指定窗口；当前桌面提供现场上下文，用户指令决定可操作对象，观察范围不等于授权范围。
- 后续计算器以结果控件中的 408 验证 `12×34`；记事本以项目 sandbox 内文件路径和真实内容验证。用户输入、焦点变化、窗口变化须重新观测。
- A04 原文包含一个低风险动作，但按用户最新顺序先完成只读检查，再开展动作小试；未完成动作验证时不能将 A04 全部标为完成。
- QQ 留待记忆阶段再讨论，区分聊天资料作为记忆来源与对外收发消息，不影响本轮桌面适配。

## 7. 复核方法与限制

以下命令不安装依赖，不启动服务，不发送付费请求。在项目目录执行：

```powershell
& '.\.venv\Scripts\python.exe' -I -c 'import sys,site; print(sys.version); print(sys.executable); print(sys.prefix); print(sys.base_prefix); print(site.ENABLE_USER_SITE)'
& '.\.venv\Scripts\python.exe' -I -c 'import importlib.metadata as m; print([(d.metadata["Name"],d.version) for d in m.distributions()])'
Get-Content -LiteralPath '.venv\pyvenv.cfg'
(Get-Item -LiteralPath 'E:\dsh\DeepSeek Harness.exe').VersionInfo | Select-Object ProductVersion,FileVersion
Get-Item -LiteralPath 'C:\Users\Mio\.dsh\profiles\desktop\node_modules\dsh-rag-workbench' | Select-Object LinkType,Target
& 'E:\file\agent\python.v\.venv\Scripts\python.exe' -I -B -c 'import sys; print(sys.version); print(sys.executable)'
```

本轮检查没有读取 `.credentials.yaml`、RAG `.env`、聊天库或完整配置内容到输出。desktop patch 只在内存中检查已知本地 MCP 地址是否存在。服务停用不阻塞独立桌面开发，亦不据此判定旧 RAG 故障。所有版本、端口和进程观察仅代表本次核对时刻。
