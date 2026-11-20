/**
 * 临时的点击定位诊断（开关式）。
 *
 * 用途：模型每做一次点击，就把"它以为点了哪里"和"系统实际点了哪里"记下来，
 * 事后能分清是模型找错了目标，还是坐标映射算错了。
 *
 * 开关：`~/.dsh/location-test.json`
 *   {"enabled": true, "dir": "E:/file/agent/ai assistant/log/location_test"}
 * 删掉这个 json 就等于关掉；连日志目录一起删，就彻底干净了（不动代码也能停）。
 *
 * 注意：这个模块只被 click 工具在"开关打开"时调用，关闭状态下不读盘、不产生任何文件，
 * 也不改变点击行为 —— 任何异常都被吞掉，绝不能让诊断把自己变成故障源。
 */
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const CONFIG_PATH = join(homedir(), '.dsh', 'location-test.json');
const CONFIG_CACHE_MS = 2000;

let cachedAt = 0;
let cachedConfig = null;

function currentConfig() {
  const now = Date.now();
  if (now - cachedAt < CONFIG_CACHE_MS) return cachedConfig;
  cachedAt = now;
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    cachedConfig = parsed?.enabled === true && typeof parsed.dir === 'string' && parsed.dir.length > 0
      ? {dir: parsed.dir}
      : null;
  } catch {
    cachedConfig = null;
  }
  return cachedConfig;
}

/** 开关是否打开（只在有配置文件且 enabled 时）。 */
export function locationTestEnabled() {
  return currentConfig() !== null;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 写一条诊断记录（一张图 + 一行 jsonl）。
 * @param record 结构化字段：工具名、坐标模式、模型给的点、换算后的全局点、观察范围、栅格尺寸等。
 * @param shot 点击前的截图（Buffer/字节），没有就传 null。
 */
export function recordLocationTest(record, shot) {
  const config = currentConfig();
  if (config === null) return;
  try {
    const dir = config.dir;
    mkdirSync(join(dir, 'shots'), {recursive: true});
    const id = `${stamp()}-${Math.random().toString(36).slice(2, 8)}`;
    let shotPath = null;
    if (shot !== undefined && shot !== null) {
      shotPath = join(dir, 'shots', `${id}.png`);
      writeFileSync(shotPath, shot);
    }
    const line = {
      id,
      at: new Date().toISOString(),
      ...record,
      shot: shotPath === null ? null : `shots/${id}.png`,
    };
    appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(line)}\n`);
  } catch {
    /* 诊断写失败不能影响点击本身 */
  }
}
