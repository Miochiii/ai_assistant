// Host-side client for the JSON run ledger. It is not a model tool and does not
// send desktop input; the fixed executor remains the only input path.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYTHON = join(ROOT, '.venv', 'Scripts', 'python.exe');
const CLI = join(ROOT, 'scripts', 'run_ledger_cli.py');

export class RunLedgerClientError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function createRunLedgerClient({ root = ROOT, python = PYTHON, cli = CLI } = {}) {
  function call(op, args, timeout = 5000) {
    const payload = JSON.stringify({ op, args });
    const completed = spawnSync(python, ['-B', cli, '--root', root], {
      input: payload, encoding: 'utf8', timeout, windowsHide: true,
      cwd: root, maxBuffer: 1024 * 1024,
    });
    if (completed.error) throw new RunLedgerClientError('RUN_LEDGER_LAUNCH_FAILED', completed.error.message);
    let value;
    try { value = JSON.parse(completed.stdout); }
    catch { throw new RunLedgerClientError('RUN_LEDGER_BAD_OUTPUT', `exit ${completed.status}`); }
    if (!value?.ok) throw new RunLedgerClientError(value?.error_code ?? 'RUN_LEDGER_ERROR', value?.message);
    return value.result;
  }

  return {
    start: args => call('start', args),
    end: args => call('end', args),
    checkpointResult: args => call('checkpoint_result', args),
    get: runId => call('get', { run_id: runId }),
    list: () => call('list', {}),
  };
}
