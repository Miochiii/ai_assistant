// Human slash command: no agent follow-up, image capture, or model request.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, requireSession } from './bridge.js';

export async function saveHostCheck(report) {
  const directory = join(root, 'results', 'host-check');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(report, null, 2), { flag: 'wx' });
  return path;
}

export function hostCheckCommand(ctx, { save = saveHostCheck } = {}) {
  return {
    definitionId: 'dsh-desktop-observe/desktop-check',
    name: 'desktop-check',
    description: '本地检查桌面工具连接和显示器；不截图、不请求模型、不操作桌面',
    recordInput: false,
    async handler(invocation) {
      if (invocation.rawInput.trim() || invocation.attachments?.length) {
        return { kind: 'error', text: '请只执行 /desktop-check，不附带文字或文件。' };
      }
      let sessionId;
      try { sessionId = requireSession(invocation); }
      catch { return { kind: 'error', text: `请先打开项目工作目录：${root}` }; }
      const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(25000)]);
      signal.throwIfAborted();
      const mode = ctx.tools.modeFor(invocation.agent);
      // Preserve the host's visibility, policy, and dispatch rules. Do not call a
      // definition body directly or forge a nested execution token under PTC.
      const result = await ctx.tools.execute({ name: 'desktop_monitors', arguments: {},
        agent: invocation.agent, callId: `desktop-check-${randomUUID()}`, signal });
      signal.throwIfAborted();
      const value = result.value;
      const passed = result.isError !== true && value?.read_only === true
        && Array.isArray(value.monitors) && value.monitors.length > 0
        && value.monitors.every(m => Number.isSafeInteger(m.index) && m.index > 0
          && Number.isSafeInteger(m.width) && m.width > 0
          && Number.isSafeInteger(m.height) && m.height > 0);
      const report = { schema_version: 1, plugin_version: '0.4.1', checked_at: new Date().toISOString(),
        session_id: sessionId, process_id: process.pid, entry: 'desktop-check-command',
        tool_presentation_mode: mode, tool: 'desktop_monitors', passed,
        ...(passed ? { monitors: value.monitors, coordinate_space: value.coordinate_space } :
          { failure: mode === 'ptc' ? 'PTC_DIRECT_DISPATCH_UNAVAILABLE' : 'TOOL_DISPATCH_FAILED' }),
        screenshot_taken: false, model_calls_by_command: 0, gui_actions: 0,
        recognition_tested: false, model_tool_selection_tested: false };
      const path = await save(report);
      return { kind: passed ? 'success' : 'error', text: passed
        ? `桌面连接自检通过：读取到 ${value.monitors.length} 个显示器。未截图、未请求模型、未操作桌面。\n记录：${path}`
        : `桌面连接自检未通过${mode === 'ptc' ? '：当前会话采用 PTC 工具模式，需要适配该调度方式' : '：工具调用失败，请查看宿主工具错误'}。未请求模型。\n记录：${path}` };
    },
  };
}
