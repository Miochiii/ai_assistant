"""Read-only diagnostics by default; --probe-move attempts one pointer move, never a click."""
import ctypes as C
from ctypes import wintypes as W
import json
import os
from pathlib import Path
import sys
import argparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from desktop_adapter.single_click import Win32Desktop, Input, MouseInput, absolute_point
from desktop_adapter.vision import Rect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe-move', action='store_true', help='Explicit diagnostic: move pointer 32 pixels; never click')
    args = parser.parse_args()
    desktop = Win32Desktop()
    user = desktop.user
    kernel = C.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentThreadId.restype = W.DWORD
    kernel.ProcessIdToSessionId.argtypes = [W.DWORD, C.POINTER(W.DWORD)]
    kernel.ProcessIdToSessionId.restype = W.BOOL
    user.GetProcessWindowStation.restype = W.HANDLE
    user.GetThreadDesktop.argtypes = [W.DWORD]
    user.GetThreadDesktop.restype = W.HANDLE
    user.OpenInputDesktop.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    user.OpenInputDesktop.restype = W.HANDLE
    user.CloseDesktop.argtypes = [W.HANDLE]
    user.CloseDesktop.restype = W.BOOL
    user.GetUserObjectInformationW.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.POINTER(W.DWORD)]
    user.GetUserObjectInformationW.restype = W.BOOL

    def name(handle):
        if not handle:
            return {'unavailable': True, 'winerror': C.get_last_error()}
        text = C.create_unicode_buffer(512)
        required = W.DWORD()
        if not user.GetUserObjectInformationW(handle, 2, text, C.sizeof(text), C.byref(required)):
            return {'unavailable': True, 'winerror': C.get_last_error()}
        return text.value

    def session(pid):
        value = W.DWORD()
        return value.value if kernel.ProcessIdToSessionId(pid, C.byref(value)) else None

    with desktop.physical_pixels():
        foreground = desktop.gui.GetForegroundWindow()
        target_pid = desktop.process.GetWindowThreadProcessId(foreground)[1]
        input_desktop = user.OpenInputDesktop(0, False, 1)
        try:
            report = {'read_only': True, 'gui_actions': 0, 'pid': os.getpid(),
                'process_session': session(os.getpid()), 'foreground_session': session(target_pid),
                'window_station': name(user.GetProcessWindowStation()),
                'thread_desktop': name(user.GetThreadDesktop(kernel.GetCurrentThreadId())),
                'input_desktop': name(input_desktop), 'foreground': foreground,
                'cursor': desktop.gui.GetCursorPos(), 'last_input_tick': desktop.input_tick(),
                'abi': {'INPUT_size': C.sizeof(Input), 'MOUSEINPUT_size': C.sizeof(MouseInput),
                        'union_offset': Input.data.offset, 'pointer_size': C.sizeof(C.c_void_p)}}
        finally:
            if input_desktop:
                user.CloseDesktop(input_desktop)
        # Serialize a synthetic event to inspect the native field layout only.
        synthetic = Input()
        synthetic.mi = MouseInput(123, 456, 0, 0xC001, 0, 0)
        report['synthetic_layout_only'] = {'type': synthetic.type, 'dx': synthetic.mi.dx,
            'dy': synthetic.mi.dy, 'flags': synthetic.mi.dwFlags, 'hex': bytes(synthetic).hex()}
        if args.probe_move:
            # Choose the pointer's current physical monitor; no window activation.
            import win32api
            monitor = win32api.GetMonitorInfo(win32api.MonitorFromPoint(tuple(report['cursor'])))['Monitor']
            left, top, right, bottom = monitor
            x, y = report['cursor']
            target = (x+32 if x+32 < right else x-32, y)
            virtual = Rect(*(user.GetSystemMetrics(i) for i in (76,77,78,79)))
            trace = {'button_events_accepted': 0}
            report.update(read_only=False, gui_actions=1, probe='pointer_move_only', move_trace=trace)
            try:
                desktop.move_verified(virtual, target, trace)
                report['probe_outcome'] = 'pointer_position_confirmed'
            except RuntimeError as error:
                report['probe_outcome'] = str(error)
            report['last_input_tick_after_probe'] = desktop.input_tick()
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
