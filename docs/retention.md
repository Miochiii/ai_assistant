# 截图与附件保留策略（2026-10-25）

## 原则

- 截图长期可发送给当前模型，不等于可以永久保存或进入记忆。
- 普通观察截图/RGB 基线短期保存。
- 只有明确被程序引用为视觉依据的图、以及 `runtime/templates` 下的模板长期保留。
- 记忆默认只存结构化结果，不存图片；`memory_images=false`，以后要存图必须单独授权。
- 删除范围覆盖项目证据目录和 Harness 附件对象副本，但只删除本地附件索引里出现过的副本。

## 配置

`configs/retention.json`：

- `ordinary_vision_ttl_hours: 24`
- `rgb_ttl_hours: 1`
- `program_basis: keep`、`templates: keep`
- `memory_images: false`
- `harness_attachments: {enabled: true, ttl_hours: 24, index: runtime/attachments.jsonl}`

## 清理

默认 dry-run：

```powershell
& '.\.venv\Scripts\python.exe' -B scripts\cleanup_evidence.py
& '.\.venv\Scripts\python.exe' -B scripts\cleanup_evidence.py --apply
```

只允许删除：

- `results/vision/*` 中超过普通 TTL、且 observation_id **不是**任何程序视觉依据的目录；
- 这些目录里的 `source.rgb`（超过 RGB TTL；即使目录因程序依据保留）；
- `%USERPROFILE%\.dsh\attachments\v1\objects\...` 中出现在 `runtime/attachments.jsonl`、
  且超过附件 TTL 的副本。

不会删除：`runtime/templates`、`runtime/programs`、程序视觉依据所在的 `screen.png`、当前仍被引用的附件。

2026-10-25 重启后 dry-run：6 个普通 vision 目录待删、49 个保留、6 个索引附件保留、0 个错误；**没有执行 --apply**，证据仍保留。

## 附件索引

`image-delivery.js` 每次把截图交给 Harness attachment store 后，尽力追加一行：

```json
{"recorded_at":"...","observation_id":"...","attachment_id":"sha256:...","media_type":"image/png"}
```

清理只按这个索引定位附件对象，不会扫描或删除其他会话的附件。索引写失败不阻塞截图交付，但该附件不会被自动清理。

## 记忆边界

- 记忆条目默认是结构化结果：任务、程序 ID、窗口身份、回执/验证引用、时间、结果状态。
- 图片只在明确晋升为程序依据/模板时长期保留；其他截图到期可删。
- 记忆读取图片前必须检查保留状态；删除记忆条目时要同时删除其受管图片引用。
- 具体记忆 schema 尚未定，等 Astra 方案后再接；本策略先把保留/删除边界固定下来。

## 限制

- 只清理索引里出现过的 Harness 附件；历史附件、其他工具生成的附件不会自动清理。
- 普通截图 TTL 以目录 mtime 为准；复制/恢复文件会改变 mtime。
- 程序视觉依据按 observation_id 保留，不按哈希；同一 observation_id 的图片被替换不会被本策略发现（proof 会校验图片哈希）。
- 没有自动定时任务；需要用户/调度器定期运行 dry-run/apply。
