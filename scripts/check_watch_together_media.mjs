import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = 'C:/Users/Mio/.dsh/profiles/desktop';
const require = createRequire(join(profile, 'package.json'));
const entry = require.resolve('dsh-watch-together');
assert(entry.replaceAll('\\', '/').startsWith(root.replaceAll('\\', '/') + 'third_party/dsh-watch-together/'));
const config = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
assert.equal(config.dsh.profile.bundles.filter(x => x === 'dsh-watch-together').length, 1);
const {DEFAULT_FFMPEG, DEFAULT_FFPROBE} = await import('../third_party/dsh-watch-together/node_modules/dsh-video-storyboard/src/storyboard/probe.js');
const {discoverYtdlp} = await import('../third_party/dsh-watch-together/node_modules/dsh-video-storyboard/src/storyboard/ytdlp.js');
const ytdlp = await discoverYtdlp();
const run = promisify(execFile);
const ffmpeg = (await run(DEFAULT_FFMPEG, ['-version'], {windowsHide: true})).stdout.split('\n')[0].trim();
await run(DEFAULT_FFPROBE, ['-version'], {windowsHide: true});
await run('python', ['-c', 'import tkinter; print(tkinter.TkVersion)'], {windowsHide: true});
const directory = await mkdtemp(join(root, 'runtime/watch-media-'));
process.env.DSH_HOME = join(directory, 'dsh');
process.env.DSH_VIDEO_CACHE_DIR = join(directory, 'cache');
globalThis.fetch = () => { throw new Error('Network disabled in media fixture'); };
try {
  const input = join(directory, 'sample.mp4');
  const subtitle = join(directory, 'sample.srt');
  await run(DEFAULT_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=320x180:rate=10:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], {windowsHide: true, timeout: 30000});
  await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:03,500\nSynthetic subtitle for local integration.\n');
  const {runStoryboard} = await import('../third_party/dsh-watch-together/node_modules/dsh-video-storyboard/src/storyboard/pipeline.js');
  const result = await runStoryboard({input, from: 0, to: 4, transcriptFile: subtitle,
    cache: false, minFrames: 2, maxFrames: 4, maxSheets: 1, burn: 'none',
    pick: 'mid', audioStrip: false, ffmpegPath: DEFAULT_FFMPEG, ffprobePath: DEFAULT_FFPROBE});
  assert(result.sheets?.length > 0, 'Storyboard produced no sheets');
  assert.equal(result.transcript.source, 'file');
  assert(result.transcript.segments > 0);
  const report = {passed: true, installed_profile_resolves: true, ffmpeg, ffmpeg_path: DEFAULT_FFMPEG,
    yt_dlp: ytdlp.version, yt_dlp_path: ytdlp.bin, tkinter: true, synthetic_video: true,
    storyboard_sheets: result.sheets.length, subtitle_segments: result.transcript.segments,
    paid_requests: 0, live_video_verified: false};
  await mkdir(join(root, 'results/watch'), {recursive: true});
  await writeFile(join(root, 'results/watch/watch-together-media.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await rm(directory, {recursive: true, force: true});
}
