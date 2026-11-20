# 通用文本接收器适配与插入验证：设计评审

日期：2026-11-02。面向 DeepSeek 后续实现。

输入材料：`log/user_write.txt`、本轮对话，以及已查阅的 Microsoft、Chromium、IAccessible2 官方资料。

**本文是设计结论，不是已实现功能或 live 验收报告。当前阶段暂不考虑人工标注、人工教学、监督输入和未验证接收器放行。** 本次仅新增技术文稿，不修改执行器、授权或生产配置。

## 1. 结论与范围

值得做通用适配。主路线为 **Win32 标准控件快速路径 + UI Automation 通用接收器探测 + 必要时增加 IAccessible2 适配器**，实际输入继续由固定 Medium 执行器完成。

最高可行目标：对于提供足够可访问性信息的控件，自动确认接收器、执行一次受限短文本输入，并验证局部插入结果。无法保证所有网页、自绘客户端、Canvas 和游戏编辑区都提供同等级证据。

“通用”意味着按控件能力适配，而非按 QQ、Chrome、记事本等应用名称写底层放行规则；也不意味着未知控件必须自动操作成功。

上一轮加固留下了扩展缺口：标准控件能够通过，浏览器/聊天客户端缺少相应接收器适配器。下一步应补齐证据通路，不删除既有执行前校验。

保持以下约束：

- 固定 Medium 执行器；一次请求一个语义动作。
- 不开放任意 SendInput 数组，不启用剪贴板，不发送 Enter/提交。
- 密码、只读、未知接收器、危险选区替换在本阶段拒绝。
- 不以 ValuePattern 存在、类名像浏览器、机械输入曾成功作为放行依据。
- 拖拽仍保持现有禁用条件，不属于本次工作。
- 不安装第二条 grounding 模型线，不开展付费模型实验。

### 1.1 已知事实与待验证事项

| 类别 | 结论 |
| --- | --- |
| 项目报告的事实 | `user_write.txt` 报告标准 Edit live 输入成功；Low 观察侧 EM_GETSEL 被拒绝，Medium 输入前校验可用。本文未重新进行 live 验收 |
| 代码核对的事实 | 当前代码允许观察侧 `selection_probe=unavailable`，但执行时仍要求选区折叠；已有 Edit/RichEdit 分类逻辑 |
| 项目报告的事实 | 某 Chrome 探测只发现一个未获得键盘焦点的 ValuePattern 元素；某 QQ 树遍历返回 COMError |
| 不能据此推导 | Chrome 一定不支持 TextPattern；QQ 永久无法支持 UIA；所有 RichEdit 变体都已经验收 |
| 需要实测 | 具体浏览器/客户端版本的 Pattern、焦点与编辑宿主关系、可访问性激活状态、选区及文本范围可靠性 |

## 2. 推荐架构与接口

### 2.1 技术路线比较

| 层 | 类型/编辑属性 | 焦点、选区、光标 | 使用建议 |
| --- | --- | --- | --- |
| Win32 Edit / 经验证 RichEdit | 类、样式可提供密码/只读等状态 | 原生焦点和选区消息；跨完整性可能受限 | 保留快速路径，按具体控件能力验证 |
| UI Automation | ControlType、IsPassword、IsEnabled；可编辑/只读需要 Pattern 或文本属性组合判断 | 焦点属性；TextPattern 可给选区；TextPattern2 可给活动 caret | 主路线；不能由 Edit/Document 类型直接推出可编辑 |
| MSAA + IAccessible2 | MSAA 提供角色/状态；IA2 提供更丰富文本能力 | IA2 可提供 caretOffset、selection 等 | UIA 不足时再增加；MSAA 单独通常不足以完成文本插入校验 |
| Chromium accessibility | 浏览器内部的可访问性语义 | 经 UIA/IA2 等平台接口对外暴露 | 用于诊断，不另造浏览器专用输入执行器 |
| 浏览器扩展/DOM | 元素、编辑属性、DOM 选区和值 | 对具体页面可提供更直接的信息 | 后续可选独立 provider；需要单独权限和页面绑定，不属于当前 PoC |
| TSF | 文本服务、输入法上下文协作 | 依赖应用/文本服务集成 | 当前不作为通用跨进程探测主线 |

IAccessibleText 的正式接口包含 caretOffset、nSelections 等能力，但是否可用取决于实际 provider。[IA2 接口文档](https://accessibility.linuxfoundation.org/a11yspecs/ia2/docs/html/interface_i_accessible_text.html)

### 2.2 分离探测、许可与执行

```text
现有视觉观察 → 候选目标与授权窗口
                    ↓
          probe_receiver（只读能力探测）
                    ↓
          validate_receiver（输入前重新校验）
                    ↓
          固定 Medium 执行器（一次短文本动作）
                    ↓
          verify_insertion（局部结果验证）
                    ↓
          回执 / 操作日志 / 上层任务验证
```

三个接口是建议新增的内部职责，不是已经存在的工具名。provider 不直接调用 SendInput、SetValue 或剪贴板，不自行扩大授权。

建议接收器证据包含：

```text
provider
receiver_token
authorized_window
focus: true | false | unknown
editable: true | false | unknown
password: true | false | unknown
readonly: true | false | unknown
selection_state: collapsed | selected | multiple | unknown
caret_available
verification_methods
observed_at
evidence_sources
unavailable_reasons
```

- 来源与证据等级分离：同为 UIA，可能这次完整、下次失效；不能只凭 provider 名称放行。
- 未支持、COM 失败、属性缺失与默认值不能被静默转成安全的 `false`；必须区分未知。
- `receiver_token` 是宿主内部短期绑定，不接受模型自行编造证据。
- UIA 元素可能没有独立 HWND。按授权顶层窗口、元素所属关系、当前焦点和短期身份联合绑定，不能把“必须存在子窗口 HWND”照搬给网页控件。
- RuntimeId 只用于当前生命周期内的身份线索，不作为跨会话永久定位器。多进程应用也不能只靠元素 PID 等于顶层 PID 判断归属。
- Low 观察侧可以报告缺少能力证据；执行许可必须由 Medium 层在动作前复核。历史观察未知不等于当前安全，但可由新鲜的执行前证据补齐。

### 2.3 UIA 探测方法与运行位置

先调用 `GetFocusedElement()`，检查与授权窗口的关系及 `HasKeyboardFocus`，必要时有限查找相关祖先文本容器。不要每轮从窗口 `FindAll(descendants)` 后选第一个 ValuePattern。[Microsoft 元素获取文档](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-obtainingelements)

建议在独立 Medium 探测进程的 MTA 线程中调用 UIA，不持有键鼠按下状态。Microsoft 建议桌面 UIA 调用使用不拥有窗口的独立 MTA 线程；额外进程隔离、超时和重启机制是本项目的工程设计。[线程模型说明](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)

复用已报告可用的 `comtypes + UIAutomationCore`，先核对实际版本、位数、COM 初始化方式和 HRESULT；不在 PoC 阶段同时引入多套框架。

性能策略：只在准备文本动作时探测当前焦点，限定范围与耗时；缓存能力线索，不缓存焦点/选区作为执行许可。UIA 卡住只允许停止无输入职责的探测进程，不将“可以 kill 探测进程”推广到持键执行器。

## 3. 能力分级、证据与拒绝条件

| 类型 | 最低证据 | 本阶段允许范围 |
| --- | --- | --- |
| `win32.edit` / 已验收 RichEdit | 接收器身份一致、焦点一致、非密码、非只读，执行前选区折叠 | 现有短文本输入；是否能证明插入另行判断 |
| `uia.text_edit` | 授权窗口内当前焦点；明确可编辑/非密码/非只读；TextPattern 给出可确认的折叠选区 | 受限短文本；采用实际可用的局部验证方式 |
| `uia.value_edit` | 焦点和身份、密码/只读状态及 ValuePattern | 单靠这些不放行；必须从其他可信接口补齐选区证据，否则拒绝 |
| `ia2.text_edit` | 对应身份、焦点、保护/可编辑状态，选区与光标证据 | 后续适配和验收通过后开放 |
| 未知/不完整接收器 | 关键字段缺失、冲突或过期 | 拒绝输入，返回结构化原因；没有人工确认后备入口 |

ValuePattern 提供值和只读状态，不提供文本选区接口。不得用 `SetValue` 替代插入：它可能覆盖整个字段，改变现有动作语义。[ValuePattern 文档](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nn-uiautomationclient-iuiautomationvaluepattern)

TextPattern 存在也不代表可编辑；只读文档同样可能支持文本访问。TextPattern 的读取和范围操作不能直接替代实际输入。[TextPattern 概述](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-textpattern-overview)

共同拒绝条件：目标归属未知、焦点不一致、密码/只读明确或关键状态未知、非折叠/多重选区、元素失效、探测超时、观察与当前状态冲突。输入后才发生失败时必须保留已接收事件，报告结果未知，禁止自动重发。

### 3.1 Chromium 的特殊诊断注意事项

Chrome 138 起默认启用原生 Windows UIA，但这不是每个元素都提供完整 Pattern 的保证；嵌入式 Chromium/Electron 的具体版本与实现仍需检测。[Chrome 官方说明](https://developer.chrome.com/blog/windows-uia-support-update)

- 普通 `<input>`、`textarea` 作为第一批验收目标，逐个检测实际 Pattern。
- `contenteditable` 需确认编辑宿主、当前焦点元素与文本容器的对应关系。
- React 是开发框架，不能作为接收器能力标签；它可能使用原生 input、contenteditable、隐藏 textarea 或 Canvas。
- `IsKeyboardFocusable=true` 不等于当前有焦点；文档中 `HasKeyboardFocus=0` 的元素不能直接用作输入目标。
- `--force-renderer-accessibility` 或 `chrome://accessibility` 用于受控对照诊断，不自动修改用户全局启动配置。启用可访问性不会凭空补齐应用没有实现的语义。

Chromium 的可访问性可能按需激活；旧技术文档部分描述较早版本，不能用其中“UIA 很有限”的历史表述否定新版原生 UIA。[Chromium 技术说明](https://www.chromium.org/developers/design-documents/accessibility/)

## 4. 插入验证与隐私边界

### 4.1 四种证据分开记录

建议新增或映射到现有回执的独立状态：

```text
api_accepted                接口是否接收输入事件
receiver_verified           动作前接收器约束是否满足
insertion_verified          预期文本是否在目标位置出现
task_success_verified       业务目标是否完成
```

每项应支持未知/不适用及原因，不能合并成一个 `success`。接收器验证是动作前状态，不是输入后结果；插入成立也不证明保存、发送等业务成功。

### 4.2 折叠选区与光标

`TextPattern.GetSelection()` 成功返回一个文本范围后，用同一范围的 `CompareEndpoints(Start, End)` 判断端点相等。NULL、调用失败、空集合、多段选区不能当成安全的折叠选区。[GetSelection 语义](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationtextpattern-getselection)

若支持 TextPattern2，可调用 `GetCaretRange` 并检查 `isActive`。活动 caret 是补充证据，不能替代选区检查。[GetCaretRange 文档](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationtextpattern2-getcaretrange)

UIA 的文本范围不能当作跨重绘永久稳定的字符索引；完整替换内容可能使旧范围失效，局部修改时端点也可能随 provider 更新。遇到失效需重新取证，不能将异常视为匹配成功。[文本范围有效性说明](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-textpattern-overview)

### 4.3 如何证明插入

优先方案：授权允许局部读取时，在同一接收器内对插入点附近的有限文本进行前后比较，结合插入位置和上下文判断预期变化。

短小普通字段可使用 `ValuePattern.CurrentValue` 前后比较，但必须先得到读取授权和非密码等证据。不能只比较长度，不能把预期内容在字段其他位置出现当作本次插入成功。

只看 caret 位移、TextChanged、SelectionChanged 或画面变化，不能可靠证明具体文本完整插入。若不允许读取正文，可以记录这些弱证据，但 `insertion_verified` 保持 unknown；若该任务要求确定验证，则应在输入前判定该能力不满足，而非输入后自动重试。

contenteditable 的较强证据是：同一编辑宿主内，局部文本与预期变化一致，焦点/选区仍符合条件；重绘后内容没有被撤回。一次事件通知不足以证明完成。复杂 IME、自动格式化或规范化尚未支持时，不静默套用宽松比较。

### 4.4 隐私

- 密码/保护状态检查在正文读取前完成；未知时不读取正文来“猜是否密码”。
- 初始 PoC 只读元数据，不读 `CurrentValue`、TextRange 正文或整棵树的 Name/Value。
- 后续只读取经授权的局部、有限长度内容，在本地短期使用，不写日志/记忆/异常，不发送模型。
- 日志保存验证方法、结果、范围大小和错误原因；不保存前后正文。
- 短文本普通哈希不等于脱敏，可能被枚举；不作为默认审计字段。
- Python/COM 字符串不保证物理内存即时擦除，不宣称实现安全清零。

## 5. 分阶段实施与测试

以下文件名是建议职责划分，可根据现有结构调整；不得将本文的接口草案误报为已实现。

| 阶段 | 建议代码工作 | 离线测试 | live 验收与回滚 |
| --- | --- | --- | --- |
| A：只读 PoC | 新增 receiver evidence 类型及 UIA probe；独立 Medium worker；暂不接输入 | 缺失属性、默认值误判、焦点不符、授权窗口不符、超时、COMError、元素失效 | 本地测试页探测普通/密码/只读/有选区输入框及 contenteditable；挂起或误认即停用 provider |
| B：普通网页短文本 | 将 validator 接入 executor；增加局部 insertion verifier；保留原生快速路径 | 选区替换拒绝、焦点切换、取消、部分输入、代理对、读取未授权、验证失败不重试 | 使用非重要测试页输入固定短文本；错框、替换选区、假成功任一发生，退回只读 |
| C：contenteditable/Electron | 编辑宿主映射、重绘后的证据重取；有明确需要再加 IA2 provider | 焦点子元素、元素重建、文本范围失效、选区跨节点、内容自动撤回 | 一次性本地草稿逐控件验收；不因同为 Electron 全量放行 |
| D：QQ 等证据不足目标 | 有界诊断 UIA/IA2，记录版本及 HRESULT | provider 不可用必须返回 unsupported，不能落入裸 SendInput | 不用真实聊天对象做首轮试验；仍无证据则保持不支持，不开发应用名白名单 |

实施建议：证据类型与 provider 注册放在独立模块，`single_click.py` 保留底层输入职责，`executor.py` 调用统一 validator，回执保留独立验证结果。新增 provider 用开关逐步启用；回滚关闭新 provider，不回滚安全门禁。

所有涉及动作行为或验证语义的变更，需要审视 executor/receipt/program proof 的版本兼容；不要仅修改旧 PreAct JSON 版本号后继续沿用旧证明。仅增加只读 PoC 时，不需要为其伪造动作验收或批量迁移程序库。

## 6. 风险与当前不支持范围

- UIA/IA2 属性来自应用，不是针对恶意 provider 的安全证明；非密码属性也不意味着内容不敏感。
- COMError 应先区分初始化、位数、权限、失效和 provider 错误；它不等于永久不支持，也不能忽略。
- 同窗口可以换焦点；截图识别正确不代表执行接收器正确。探测与输入之间存在竞态，只能缩短窗口并检测，不能宣称消除。
- 不发送 Enter 也可能触发自动保存、搜索、同步或网页脚本副作用；文本输入权限不能自动推导出所有业务副作用都获授权。
- UIA 文本范围、UTF-16 unit、Unicode scalar、字素与视觉位置并不等价；不要用 caret 移动数量硬算实际输入字数。
- Canvas、游戏、自绘区、终端、复杂 IME、提升权限目标或安全桌面，不作为当前通用自动输入验收范围。
- 旧窗口句柄、旧 RuntimeId、旧选区证据不可变成跨会话长期许可。

对 `user_write.txt` 中的 `user_confirmed_unverified` 提议，本轮决策是：**暂不实现、不开工具入口、不由模型参数开启、不作为失败后的自动降级。** 人工标注/监督属于后续单独设计，不混入当前已验证输入路径。

## 7. 唯一优先的最小下一步

**做一个不输入、不读取正文的 Medium UIA 焦点接收器诊断 PoC。**

输出限于：授权窗口关系、当前焦点、控件类型、明确报告的密码/只读/可编辑状态、可用 Pattern、选区是否折叠、活动 caret 能力、耗时和结构化错误（含 HRESULT）。缺少任何证据都如实标 unknown，不通过遍历更多正文补救。

验收目标是回答：当前受阻究竟来自探测方法、执行环境，还是控件确实不暴露所需能力。首轮在本地测试页完成，不修改用户浏览器全局配置，不开启实际文本输入。

PoC 结果明确后，再决定普通网页输入能否进入阶段 B；在此之前，保持既有文本输入许可和 fail-closed 规则。
