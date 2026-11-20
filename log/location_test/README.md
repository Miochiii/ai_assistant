# 点击定位诊断（临时）

> **2026-11-19 清理过一轮**：`shots/` 与 `annotated/` 里 50 组截图（26.7 MB）已删除，只保留
> `events.jsonl`（50 条点击的坐标记录，31 KB）。坐标数据是分析用的核心，截图可随时用同样指令重跑。
> 要重新生成标注图：把开关打开、点几次，再跑下面 `annotate.py` 的命令。

用途：模型点一次，就把「它以为点了哪」和「系统实际点了哪」记下来，事后能分清是**模型找错目标**还是**坐标映射算错**。不看屏幕也知道点歪在哪一步。

## 开关

开关是一个文件，不碰代码：

```
C:\Users\Mio\.dsh\location-test.json
{"enabled": true, "dir": "E:/file/agent/ai assistant/log/location_test"}
```

- **打开**：写出这个 json（`enabled: true` + 日志目录）；
- **关闭**：删掉这个 json —— 下一次点击起就不再记录；
- **彻底清理**：删 json + 删本目录（`log/location_test/`），代码保持原样，不需要回滚任何东西。

开关关闭时：不读盘、不截图、不产生文件，点击路径与原来完全一致。

## 目录结构

```
log/location_test/
├── events.jsonl        # 一行一次点击（jsonl，追加写）
├── shots/              # 点击前的截图（PNG），文件名 = 记录 id
└── annotated/          # 画好十字的副本（由 annotate.py 生成）
```

`events.jsonl` 每行的字段：

| 字段 | 含义 |
|---|---|
| `id` / `at` | 记录 id / 时间 |
| `mode` | 坐标模式：`millifraction`（0–1000）或 `pixel` |
| `modelPosition` | **模型给的原始坐标**（没换算前） |
| `hidPosition` | 换算到 0–1000 之后的值 |
| `global` | 换算出的**全局屏幕坐标**（真正点击的位置） |
| `screen.bounds` | 这次观察的范围（x/y/宽/高） |
| `screen.scale` | 显示器缩放 |
| `screen.windowId` / `appName` | 观察的窗口与应用名 |
| `raster` | 模型看到的截图尺寸（宽×高） |
| `insideObservation` | 全局点是否落在观察范围内 |
| `shot` | 点击前截图相对路径 |

## 画十字看结果

```powershell
& "C:\Users\Mio\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" tools\location-test\annotate.py
```

输出在 `annotated/`：

- **蓝十字**：换算后的点击点（画在截图上）
- **红圈**：截图中心，用来判断「是不是整体偏移」

同时打印一张表，包含 mode / 模型点 / 全局点 / 是否在范围内 / 截图尺寸。

> 项目 `.venv` 里没有 Pillow，所以用 DSH 运行时的 python（上面那条路径）跑。

## 怎么用它判定问题

| 现象 | 结论 |
|---|---|
| 蓝十字压在目标控件上，但界面没反应 | 不是坐标问题：点到了但没生效（可能被遮挡、控件不响应、或点后状态已变） |
| 蓝十字整体偏一段固定距离 | 坐标映射问题（窗口 vs 显示器、DPI、裁剪偏移）；看 `bounds` 和 `raster` 的比例 |
| 蓝十字在范围内但目标在别处 | **模型找错目标**（不看坐标链，改提示/确认流程） |
| `insideObservation: false` | 换算点跑出观察范围 —— 映射或边界问题（如 1000 越界） |
| `bounds` 明显大于/小于截图 | 窗口图与显示器 bounds 混用（见下） |

## 「窗口图 vs 显示器 bounds」怎么验

有了上面的记录就不用专门做实验，一次点击就能判：

1. 打开一个**不满屏**的窗口（比如记事本拖到屏幕右下角），让模型点它中间的一个按钮；
2. 看记录里的三个数：
   - `screen.bounds`（观察范围）
   - `raster`（截图尺寸）
   - 实际显示器分辨率（1707×960 DIP / 2560×1440 物理）
3. 判读：
   - `bounds` ≈ 窗口位置尺寸 → **窗口级**观察（映射按窗口，正确）；
   - `bounds` ≈ 整屏 → **显示器级**（映射按整屏）；
   - 两者都不是、且 `raster` 宽度 / `bounds.width` ≠ 1 → **裁剪或缩放没对齐**。
4. 再交叉验证：让模型点窗口**左上角**与**右下角**各一个已知元素。若两次都落在正确位置 → 映射与该 bounds 一致；若整体平移一个固定量 → bounds 的 x/y 取错了（比如用了全屏原点）。

## 清理

```powershell
Remove-Item "$env:USERPROFILE\.dsh\location-test.json"      # 关开关
Remove-Item -Recurse -Force "E:\file\agent\ai assistant\log\location_test"   # 删日志
```
