"""Local single-click integration probe; no model loop or automatic retries."""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sys
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from desktop_adapter.vision import capture, Rect, screen_point
from desktop_adapter.single_click import Win32Desktop, validate_age, validate_pixels, input_delivery_observed


def local_path(value, folder='results'):
    path = Path(value).resolve(strict=True)
    if not path.is_relative_to((ROOT / folder).resolve()):
        raise ValueError('Evidence must stay within project results')
    return path


def save(path, value):
    with path.open('x', encoding='utf-8') as file:
        json.dump(value, file, ensure_ascii=False, indent=2)


def observe(desktop, hwnd, region, region_space='explicit'):
    from mss import MSS
    if region_space not in {'client', 'window', 'explicit'}:
        raise ValueError('Invalid region_space')
    started = time.perf_counter()
    context_started = time.perf_counter()
    context_before = desktop.window_context(hwnd)
    context_ms = round((time.perf_counter() - context_started) * 1000, 2)
    window = desktop.identity(hwnd)
    identified = time.perf_counter()
    if desktop.gui.GetForegroundWindow() != hwnd:
        raise ValueError('Target window must be foreground for an action observation')
    binding = {'window': window, 'foreground': desktop.gui.GetForegroundWindow(),
               'last_input_tick': desktop.input_tick(), 'region_space': region_space}
    bounds = Rect(*region)
    left, top, right, bottom = window['rect']
    if region_space == 'client':
        client = context_before.get('geometry', {}).get('client_rect_screen_px')
        if not isinstance(client, dict) or not Rect(**client).contains(bounds):
            raise ValueError('Observation must stay within the client area')
    elif not Rect(left, top, right-left, bottom-top).contains(bounds):
        raise ValueError('Observation must stay within selected window')
    with MSS() as sct:
        monitors = sct.monitors
        index = next((i for i, m in enumerate(monitors) if i > 0 and Rect(**{k: m[k] for k in ('left', 'top', 'width', 'height')}).contains(bounds)), None)
    if index is None:
        raise ValueError('Region must fit one monitor')
    folder = ROOT / 'results' / 'vision' / str(uuid4())
    observation = capture(folder, monitor=index, region=bounds, retain_rgb=True)
    captured = time.perf_counter()
    context_after = desktop.window_context(hwnd)
    if (context_before.get("identity") != context_after.get("identity")
            or context_before.get("geometry", {}).get("geometry_revision")
            != context_after.get("geometry", {}).get("geometry_revision")):
        (folder / 'source.rgb').unlink()
        raise ValueError('Window context/geometry changed during observation')
    if desktop.identity(hwnd) != window or desktop.input_tick() != binding['last_input_tick']:
        (folder / 'source.rgb').unlink()
        raise ValueError('Window/input changed during observation')
    binding.update(source_sha256=observation['image']['sha256'],
                   rgb_sha256=hashlib.sha256((folder / 'source.rgb').read_bytes()).hexdigest())
    try:
        focus = desktop.focus_info(hwnd)
    except Exception as error:
        focus = {'available': False, 'error_code': type(error).__name__}
    observation['focus'] = focus
    binding['focus'] = focus
    observation['window_context'] = context_after
    observation['region_space'] = region_space
    binding['window_context'] = context_after
    observation['timings'] = {
        **(observation.get('timings') or {}),
        'identity_ms': round((identified - started) * 1000, 2),
        'window_context_ms': context_ms,
        'observe_total_ms': None,
    }
    observation['window'] = window
    save_started = time.perf_counter()
    save(folder / 'observation.json', observation)
    manifest_saved = time.perf_counter()
    save(folder / 'click-binding.json', binding)
    binding_saved = time.perf_counter()
    observation['timings']['manifest_write_ms'] = round((manifest_saved - save_started) * 1000, 2)
    observation['timings']['binding_write_ms'] = round((binding_saved - manifest_saved) * 1000, 2)
    observation['timings']['observe_total_ms'] = round((binding_saved - started) * 1000, 2)
    # Persist the final timing summary in the manifest, then keep a small sidecar.
    (folder / 'observation.json').write_text(
        json.dumps(observation, ensure_ascii=False, indent=2), encoding='utf-8')
    save(folder / 'observation-timing.json', observation['timings'])
    return {'observation': str(folder / 'observation.json'), 'image': observation['image'], 'window': window,
            'timings': observation['timings']}


def execute(desktop, manifest_arg, result_arg, label):
    from mss import MSS
    manifest = local_path(manifest_arg, 'results/vision')
    observation = json.loads(manifest.read_text(encoding='utf-8-sig'))
    folder = manifest.parent
    binding = json.loads((folder / 'click-binding.json').read_text(encoding='utf-8-sig'))
    result = json.loads(local_path(result_arg).read_text(encoding='utf-8-sig'))
    # A consumed observation is never clicked twice, even after failure/crash.
    with (folder / 'click.once').open('x'):
        pass
    report = {'gui_clicks_attempted': 0, 'outcome': 'unknown', 'input_backend': 'Win32 SendInput',
              'model_result': str(local_path(result_arg)), 'source_observation': str(manifest),
              'source_sha256': observation['image']['sha256'], 'label': label}
    try:
        validate_age(observation['captured_at'])
        image = local_path(observation['image']['path'], 'results/vision')
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        if digest != binding['source_sha256'] or digest != result.get('source_sha256') or digest != observation['image']['sha256']:
            raise ValueError('Recognition/source image mismatch')
        if not result.get('passed') or not result.get('structural_validation', {}).get('valid'):
            raise ValueError('Recognition did not pass structural validation')
        answer = json.loads(result['answer'])
        candidates = [target for target in answer['targets'] if target['label'] == label]
        if len(candidates) != 1:
            raise ValueError('Target missing or ambiguous')
        bounds = Rect(**observation['capture_bounds'])
        size = result['attachment_size']
        point = screen_point(bounds, (size['width'], size['height']), *candidates[0]['center'])
        raw = (folder / 'source.rgb').read_bytes()
        if hashlib.sha256(raw).hexdigest() != binding['rgb_sha256']:
            raise ValueError('Pixel baseline mismatch')
        desktop.check_target(binding, point)
        with MSS() as sct:
            display = Rect(**{k: sct.monitors[0][k] for k in ('left', 'top', 'width', 'height')})
            fresh = sct.grab(asdict(bounds)).rgb
            validate_pixels(raw, fresh, (bounds.width, bounds.height), (point[0]-bounds.left, point[1]-bounds.top))
            desktop.check_target(binding, point)
            report['screen_point'] = point
            report['input_trace'] = {}
            def before_buttons():
                desktop.check_window_point(binding, point)
                if desktop.gui.GetForegroundWindow() != binding['foreground']:
                    raise ValueError('Foreground changed after pointer move')
                report['gui_clicks_attempted'] = 1
            report['input_events_sent'] = desktop.click(display, point, trace=report['input_trace'], before_buttons=before_buttons)
        time.sleep(0.35)
        report['cursor_after'] = desktop.gui.GetCursorPos()
        report['foreground_after'] = desktop.gui.GetForegroundWindow()
        report['last_input_tick_after'] = desktop.input_tick()
        report['input_delivery_observed'] = input_delivery_observed(point, report['cursor_after'],
            binding['last_input_tick'], report['last_input_tick_after'])
        after_folder = ROOT / 'results' / 'vision' / str(uuid4())
        after = capture(after_folder, monitor=observation['monitor_index'], region=bounds)
        save(after_folder / 'observation.json', after)
        report.update(after_observation=str(after_folder / 'observation.json'), after_image=after['image'],
                      window_after=desktop.identity(binding['window']['hwnd']),
                      input_api_accepted=True, task_success_verified=False)
        if not report['input_delivery_observed']:
            report['error'] = 'INPUT_DELIVERY_UNCONFIRMED: cursor/input readback does not confirm delivery; no retry'
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
    finally:
        (folder / 'source.rgb').unlink(missing_ok=True)
        report['temporary_rgb_removed'] = True
    # This receipt is written only after the attempt and post-action capture.
    save(folder / 'click-result.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('windows')
    sub.add_parser('state')
    prep = sub.add_parser('observe')
    prep.add_argument('--hwnd', type=int, required=True)
    prep.add_argument('--region', type=int, nargs=4, required=True)
    prep.add_argument('--region-space', choices=('client', 'window', 'explicit'), default='explicit')
    click = sub.add_parser('click')
    click.add_argument('--observation', required=True)
    click.add_argument('--result', required=True)
    click.add_argument('--label', required=True)
    args = parser.parse_args()
    desktop = Win32Desktop()
    with desktop.physical_pixels():
        if args.command == 'windows':
            result = desktop.list_windows_with_context()
        elif args.command == 'state':
            result = {'cursor': desktop.gui.GetCursorPos(), 'foreground': desktop.gui.GetForegroundWindow(),
                      'last_input_tick': desktop.input_tick()}
        elif args.command == 'observe':
            result = observe(desktop, args.hwnd, args.region, args.region_space)
        else:
            result = execute(desktop, args.observation, args.result, args.label)
    print(json.dumps(result, ensure_ascii=True))
    return 1 if isinstance(result, dict) and 'error' in result else 0


if __name__ == '__main__':
    raise SystemExit(main())
