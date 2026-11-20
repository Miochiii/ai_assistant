import {readFile, mkdir, writeFile, rename} from 'node:fs/promises';
import {dirname} from 'node:path';
export const DEFAULTS = {mode: 'screen', captureSeconds: 2, lookSeconds: 30, speakSeconds: 30, backoff: true, proactive: true};
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式无效');
  // Settings saved before the manual selector continue to use screen Watch.
  value = {...value, mode: value.mode === undefined ? 'screen' : value.mode};
  if (!['screen', 'video'].includes(value.mode)) throw new Error('请选择屏幕陪伴或视频陪看');
  for (const [key, min, max] of [['captureSeconds', 1, 10], ['lookSeconds', 10, 180], ['speakSeconds', 0, 300]]) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`${key} 必须为 ${min}–${max} 的整数`);
  }
  for (const key of ['backoff', 'proactive']) if (typeof value[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`);
  return Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, value[key]]));
}
export function settingsStore(path) {
  let queue = Promise.resolve();
  return {
    async read() {try {return validateSettings(JSON.parse(await readFile(path, 'utf8')));} catch (error) {if (error.code === 'ENOENT') return {...DEFAULTS}; throw error;}},
    save(value) {
      const settings = validateSettings(value);
      const task = queue.then(async () => {
        await mkdir(dirname(path), {recursive: true});
        await writeFile(path + '.tmp', JSON.stringify(settings, null, 2));
        await rename(path + '.tmp', path); return settings;
      });
      queue = task.catch(() => {}); return task;
    },
  };
}
export function parseCompanionReply(raw, parseStructured) {
  const parsed = parseStructured(raw);
  if (parsed.structured) return parsed;
  const text = String(raw ?? '').trim();
  if (text && text.length <= 2400 && !/^[{\[<`]/u.test(text)
      && !/"(?:speak|text|reason)"\s*:|\btool_call\b/u.test(text)) {
    return {structured: true, speak: true, text, reason: 'plain_text'};
  }
  return {structured: false, speak: false, text: '', reason: 'invalid_format'};
}
