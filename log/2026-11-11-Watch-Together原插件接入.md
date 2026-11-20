# Watch Together 原插件接入

2026-11-11，按用户要求直接复用下载的插件，不另写陪看引擎。

## 安装结果

- 源码：`E:/file/agent/ai assistant/third_party/dsh-watch-together`，0.3.3。
- 原版依赖：`dsh-video-storyboard` 0.7.4，锁定于源码目录的 package-lock.json；安装时禁用生命周期脚本。
- DSH desktop 的 node_modules/dsh-watch-together 已建立指向上述源码的 Junction。
- desktop/package.json 新增本地 link 依赖和 bundle；pnpm-lock.yaml 同步 link。
- 原有 cordis.patch.yml 未改，现有 Orb 和 Memory Evolve 配置保留。
- 配置备份：`runtime/watch-together-install/20261111-222641/`，含原 package.json、pnpm-lock.yaml、cordis.patch.yml 和安装后哈希。
- 未修改上游插件源代码；Orb 开发版仍为 0.2.1-mio-dev.10。没有重启正在运行的 DSH。

## 媒体工具

- FFmpeg / ffprobe / ffplay 9.0.2 essentials，来自上游设置页列出的 gyan.dev 官方构建下载地址。
- 文件在 `third_party/runtimes/watch-tools/ffmpeg/ffmpeg-9.0.2-essentials_build`。
- `C:/Users/Mio/.dsh/tools/ffmpeg` Junction 指向该目录，由插件原生发现机制读取，无须修改系统 PATH。
- GitHub release-assets 下载不可达，yt-dlp 改由 pip 的现有 PyPI 镜像安装；版本 2026.10.26。
- 插件实际发现路径：`C:/Users/Mio/AppData/Roaming/Python/Python312/Scripts/yt-dlp.exe`。
- `third_party/runtimes/watch-tools/python` 还有一份前期 target 安装副本，运行时使用上述用户安装。
- Python tkinter 导入成功。

## 验证范围

1. 上游依赖契约、工具 schema、设置页测试共 19 项通过。
2. `scripts/check_watch_together_native.mjs`：真实 DSH SDK、上游兼容 defineTool 路径，成功注册 watch_together、watch_together_settings 和设置路由；卸载后全部清理。结果：`results/watch/watch-together-native.json`。
3. `scripts/check_watch_together_media.mjs`：从实际 desktop profile 解析插件，默认路径发现并执行 FFmpeg/ffprobe/yt-dlp；合成 4 秒视频与 SRT 字幕，通过原版 pipeline 输出 1 张分镜和 1 段字幕。结果：`results/watch/watch-together-media.json`。
4. 上游 install-extension --verify 检查源码 extension 目录完整，版本 0.0.7。

没有调用付费模型，没有读取浏览器登录凭证。以上不代表浏览器扩展已启用或 B 站真实播放已验收。

## 用户验收步骤

1. 结束当前任务后退出并重新打开 DSH，使新增 bundle 加载。
2. 在 Edge 打开 `edge://extensions`，开启开发人员模式，点“加载解压缩的扩展”，选：
   `E:\file\agent\ai assistant\third_party\dsh-watch-together\extension`
   直接选择 extension 这一层，不进入 icons。然后刷新 B 站页面。
3. 如果旧 Orb 屏幕陪伴仍在运行，先发“停止陪伴”。旧引擎会拦截聊天消息；“开始陪伴”仍是旧入口。
4. 发“调用 watch_together_settings，打开一起看设置”，检查原插件设置入口。原生页面在插件详情/内置插件区域，不是先前的 Orb 屏幕陪伴设置卡片。
5. 在浏览器播放视频，然后发“请调用 watch_together，陪我看正在播放的视频”。先确认位置桥提供视频标题和播放位置，再确认分镜和字幕。
6. 若字幕取不到，按插件的具体原因处理登录态或 ASR。当前未配置新的 ASR、TTS 适配器，也未登录或导出 B 站 cookies。

声音含义：此阶段验证的是分镜加字幕；无字幕视频需要 ASR 才能获得对白内容。不能把安装完成描述为模型已经直接听见系统音频。

## 回退

先退出 DSH，再根据 installation.json 核对安装后哈希。若配置此后未变化，可以恢复本次备份的 package.json 和 pnpm-lock.yaml，并只移除 node_modules/dsh-watch-together 的 Junction（保留 E 盘源码）。若已发生后续变更，只撤回新增 dependency/bundle/lock 项，不整文件覆盖。FFmpeg 和 yt-dlp 可保留给其他视频工具使用。
