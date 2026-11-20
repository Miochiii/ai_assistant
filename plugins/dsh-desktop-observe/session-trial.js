import { fork } from 'node:child_process';
import { join } from 'node:path';
import { root, requireSession } from './bridge.js';
import { readPlan, inspectPlan, trialAlreadyStarted } from '../../scripts/desktop_session_plan.mjs';

export function launchSessionWorker(mode, sessionId, signal) {
  signal?.throwIfAborted();
  if (!['offline', 'run'].includes(mode)) throw new Error('Invalid worker mode');
  return new Promise((resolve, reject) => {
    const child = fork(join(root, 'scripts', 'run_dsh_desktop_session.mjs'),
      [`--${mode}`, `--parent-session=${sessionId}`], {
        execPath: 'E:\\dsh\\DeepSeek Harness.exe', execArgv: ['--expose-internals'],
        cwd: root, windowsHide: true, silent: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
    let output = '', cancelled = false, killTimer;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (child.connected) child.send({ type: 'cancel' }, () => {});
      killTimer = setTimeout(() => child.kill(), 3000);
    };
    const timeout = setTimeout(cancel, 110000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const cleanup = () => {
      clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 256 * 1024) cancel();
    });
    // Never forward raw provider errors or credential parser output to the host.
    child.stderr.resume();
    child.once('error', () => { cleanup(); reject(new Error('隔离会话进程启动失败')); });
    child.once('close', code => {
      cleanup();
      if (cancelled) return reject(new Error('会话已取消或超时，已预留次数不退回；若被强制终止，需核对运行目录')); 
      try {
        const result = JSON.parse(output.trim());
        if (typeof result.passed !== 'boolean' || typeof result.report_path !== 'string') throw new Error();
        resolve({ ...result, passed: code === 0 && result.passed });
      } catch { reject(new Error('隔离会话未正常返回；未自动重试，请核对本地试验记录')); }
    });
  });
}

export function sessionTrialCommand(_ctx, { load = readPlan, launch = launchSessionWorker } = {}) {
  return { definitionId: 'dsh-desktop-observe/desktop-trial', name: 'desktop-trial',
    description: '查看只读验证状态；离线自检请选择 desktop-offline；run 执行已启用的验证',
    // The desktop composer only claims trailing text for descriptors with input.
    // Without this, '/desktop-trial offline' falls through to ordinary chat.
    input: { hint: 'status（状态） / offline（本地自检） / run（已批准试验）', attachments: false },
    recordInput: false,
    async handler(invocation) {
      let sessionId;
      try { sessionId = requireSession(invocation); }
      catch { return { kind: 'error', text: `请先打开项目工作目录：${root}` }; }
      const mode = invocation.rawInput.trim() || 'status';
      if (!['status', 'offline', 'run'].includes(mode) || invocation.attachments?.length)
        return { kind: 'error', text: '用法：/desktop-trial [status|offline|run]。不附加文件。' };
      invocation.signal?.throwIfAborted();
      try {
        if (mode !== 'offline') {
          const plan = await load();
          const check = inspectPlan(plan, { parentSessionId: sessionId });
          if (await trialAlreadyStarted(plan)) {
            check.ready = false;
            check.problems.push('本轮已启动过，禁止重复运行；需先核对已有记录');
          }
          if (mode === 'status' || !check.ready) return {
            kind: mode === 'run' && !check.ready ? 'error' : 'success',
            text: `只读试验：${check.ready ? '已具备运行条件' : '尚未启用'}。未请求 API。\n`
              + check.problems.join('\n')
              + `\n当前会话：${sessionId}`
              + (check.cost
                ? `\n最多 ${plan.max_requests} 次；按整段上下文与高峰价格预留 ¥${(check.cost.totalMicroCny / 1e6).toFixed(6)}，这不是预计消费。`
                : `\n小规模只读验证：最多 ${plan.max_requests} 次，每次输出上限 ${plan.max_output_tokens} token；按用户要求不计算费用。`),
          };
        }
        const result = await launch(mode, sessionId, invocation.signal);
        return { kind: result.passed ? 'success' : 'error',
          text: `${result.message ?? '试验结束，请查看记录'}\n${result.answer ?? ''}\n记录：${result.report_path}` };
      } catch (error) {
        // Launcher messages are fixed local diagnostics; other errors are not echoed.
        return { kind: 'error', text: error.message?.startsWith('隔离会话') || error.message?.startsWith('会话已取消')
          ? error.message : '试验配置或执行检查失败；未自动重试，请查看本地记录。' };
      }
    },
  };
}

export function sessionOfflineCommand(ctx, dependencies) {
  const trial = sessionTrialCommand(ctx, dependencies);
  const { input: _input, ...definition } = trial;
  return { ...definition, definitionId: 'dsh-desktop-observe/desktop-offline', name: 'desktop-offline',
    description: '零费用离线自检：旧截图 + 本地模拟响应，不调用 API、不截屏、不操作桌面',
    async handler(invocation) {
      if (invocation.rawInput.trim() || invocation.attachments?.length)
        return { kind: 'error', text: '请直接选择 /desktop-offline，不附加文字或文件。' };
      return trial.handler({ ...invocation, rawInput: 'offline' });
    },
  };
}
