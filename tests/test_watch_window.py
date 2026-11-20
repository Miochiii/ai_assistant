import unittest
from unittest.mock import patch
from tools.coach_overlay.watch_window import foreground_region, wait_foreground_region, ForegroundUnavailable


class Function:
    def __init__(self, callback): self.callback = callback
    def __call__(self, *args): return self.callback(*args)


class Windows:
    def __init__(self, root=10, pid=50, minimized=False):
        self.GetForegroundWindow = Function(lambda: 20)
        self.GetAncestor = Function(lambda hwnd, flag: root)
        self.GetWindow = Function(lambda hwnd, flag: 0)
        self.GetWindowThreadProcessId = Function(lambda hwnd, ptr: setattr(ptr._obj, 'value', pid))
        self.GetWindowRect = Function(self.rect)
        self.IsWindowVisible = Function(lambda hwnd: True)
        self.IsIconic = Function(lambda hwnd: minimized)
    def rect(self, hwnd, ptr):
        rect = (0, 0, 800, 600) if hwnd == 10 else (600, 500, 1000, 700)
        for key, value in zip(('left', 'top', 'right', 'bottom'), rect): setattr(ptr._obj, key, value)
        return 1


class WindowBindingTests(unittest.TestCase):
    def setUp(self):
        self.popups=patch('tools.coach_overlay.watch_window.visible_windows',return_value=[]).start()
        self.addCleanup(patch.stopall)

    def test_menu_outside_owner_expands_capture_without_rebinding(self):
        self.popups.return_value=[{'hwnd':30,'pid':50,'class_name':'#32768','rect':[950,650,1200,900]},
                                 {'hwnd':40,'pid':99,'class_name':'#32768','rect':[0,0,2000,2000]}]
        with patch('ctypes.WinDLL',return_value=Windows()):
            result=foreground_region(10,50)
        self.assertEqual(result['hwnd'],10)
        self.assertEqual(result['rect'],[0,0,1200,900])
        self.assertEqual([g['hwnd'] for g in result['window_geometry']],[10,20,30])

    def test_owner_popup_is_included(self):
        with patch('ctypes.WinDLL', return_value=Windows()):
            self.assertEqual(foreground_region(10, 50), {'hwnd':10,'pid':50,'foreground':20,'rect':[0,0,1000,700],
                'window_geometry':[{'hwnd':10,'rect':[0,0,800,600]},{'hwnd':20,'rect':[600,500,1000,700]}]})
    def test_other_window_pid_change_and_minimized_fail_closed(self):
        for mock in (Windows(root=99), Windows(pid=51), Windows(minimized=True)):
            with self.subTest(mock=mock), patch('ctypes.WinDLL', return_value=mock):
                with self.assertRaisesRegex(RuntimeError, 'NOT_FOREGROUND'): foreground_region(10, 50)

    def test_initial_binding_uses_visible_window_not_hidden_root_owner(self):
        windows=Windows()
        windows.GetAncestor=Function(lambda hwnd,flag: 20 if flag==2 else 10)
        windows.IsWindowVisible=Function(lambda hwnd: hwnd==20)
        with patch('ctypes.WinDLL',return_value=windows):
            self.assertEqual(foreground_region()['hwnd'],20)

    def test_owned_dialog_remains_bound_to_original_window(self):
        windows=Windows(root=20)
        windows.GetWindow=Function(lambda hwnd,flag: 10 if hwnd==20 else 0)
        with patch('ctypes.WinDLL',return_value=windows):
            self.assertEqual(foreground_region(10,50)['rect'],[0,0,1000,700])

    def test_assistant_process_is_not_selected(self):
        with patch('ctypes.WinDLL',return_value=Windows()):
            with self.assertRaises(ForegroundUnavailable) as error: foreground_region(exclude_pids=[50])
            self.assertTrue(error.exception.transient)

    def test_short_transition_retries_but_real_window_change_does_not(self):
        expected={'hwnd':10}
        with patch('tools.coach_overlay.watch_window.foreground_region',side_effect=[
            ForegroundUnavailable('transition',True),expected]) as check, patch('time.sleep'):
            self.assertEqual(wait_foreground_region(),expected)
            self.assertEqual(check.call_count,2)
        with patch('tools.coach_overlay.watch_window.foreground_region',side_effect=ForegroundUnavailable('different_window')) as check:
            with self.assertRaises(ForegroundUnavailable):wait_foreground_region(10,50)
            self.assertEqual(check.call_count,1)

    def test_transition_timeout_is_bounded(self):
        with patch('tools.coach_overlay.watch_window.foreground_region',side_effect=ForegroundUnavailable('transition',True)) as check:
            with self.assertRaises(ForegroundUnavailable):wait_foreground_region(timeout=0)
            self.assertEqual(check.call_count,1)


if __name__ == '__main__': unittest.main()
