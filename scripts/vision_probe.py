"""List monitors or capture visible pixels once. No model calls or desktop input."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from assistant_core.events import EventStore
from desktop_adapter.vision import Rect, capture


def emit(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['monitors', 'capture'])
    parser.add_argument('--monitor', type=int, default=1, help='MSS monitor index (starts at 1)')
    parser.add_argument('--session-id', default='visual-read-only', help='Event correlation only; not a file path')
    parser.add_argument('--region', type=int, nargs=4, metavar=('LEFT', 'TOP', 'WIDTH', 'HEIGHT'))
    parser.add_argument('--worker-output', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker_output:
        output = args.worker_output.resolve()
        if not output.is_relative_to((ROOT / 'results' / 'vision').resolve()):
            raise ValueError('worker output must be inside project results/vision')
        data = capture(output.parent, monitor=args.monitor, region=Rect(*args.region) if args.region else None)
        with output.open('x', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return 0
    if args.command == 'monitors':
        from mss import MSS
        with MSS() as sct:
            emit({'monitors': [{'index': i, **dict(m)} for i, m in enumerate(sct.monitors) if i > 0],
                  'coordinate_space': 'physical_desktop_pixels', 'read_only': True})
        return 0
    with EventStore(ROOT / 'runtime' / 'events.sqlite3') as store:
        run = store.start_run(session_id=args.session_id, user_scope='local-user',
                              scenario_id='visible-desktop-capture', version='0.1.0')
        output_dir = ROOT / 'results' / 'vision' / run
        output_dir.mkdir(parents=True)
        manifest = output_dir / 'observation.json'
        event = store.start_event(run, kind='observation', component='mss-capture', version='0.1.0',
                                  payload={'monitor': args.monitor, 'region': args.region, 'read_only': True})
        command = [sys.executable, '-B', str(Path(__file__).resolve()), 'capture',
                   '--monitor', str(args.monitor), '--worker-output', str(manifest)]
        if args.region:
            command += ['--region', *map(str, args.region)]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=15)
            if result.returncode:
                raise RuntimeError(result.stderr[-3000:])
            data = json.loads(manifest.read_text(encoding='utf-8'))
            evidence = [store.add_evidence(run, kind=kind, reference=str(path)) for kind, path in
                        [('screenshot', output_dir / 'screen.png'), ('observation_manifest', manifest)]]
            store.finish_event(event, status='completed', evidence_ids=evidence,
                               cost={'amount': 0, 'currency': 'USD', 'source': 'local_capture_no_model'})
            store.finish_run(run)
            emit({'ok': True, 'run_id': run, 'observation': str(manifest), 'image': data['image'],
                  'elapsed_ms': data['elapsed_ms'], 'outcome': 'unknown', 'recognition_status': 'not_run'})
            code = 0
        except (Exception, KeyboardInterrupt) as error:
            status = 'timeout' if isinstance(error, subprocess.TimeoutExpired) else 'interrupted' if isinstance(error, KeyboardInterrupt) else 'failed'
            detail = {'error_code': type(error).__name__, 'message': str(error), 'status': status}
            (output_dir / 'error.json').write_text(json.dumps(detail, ensure_ascii=False, indent=2), encoding='utf-8')
            store.finish_event(event, status=status, error_code=detail['error_code'])
            store.finish_run(run, status=status, error_code=detail['error_code'])
            emit({'ok': False, 'run_id': run, **detail})
            code = 1
        finally:
            store.export_jsonl(run, output_dir / 'events.jsonl')
    return code


if __name__ == '__main__':
    raise SystemExit(main())
