"""Local geometry/font/control regressions; no external applications or input."""
import unittest
from coach_overlay import (CoachOverlay, parse_args, corner_position, overlaps,
                           wrap_lines, WHALE_SIZE, user32, get_window_long,
                           GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT)


class LayoutTests(unittest.TestCase):
    def test_corner_order_and_exhaustion(self):
        screen = (0, 0, 2560, 1440)
        expected = [(2014, 894), (26, 894), (2014, 26), (26, 26)]
        obstacles = []
        for position in expected:
            self.assertEqual(corner_position(screen, obstacles), position)
            obstacles.append((*position, WHALE_SIZE, WHALE_SIZE))
        self.assertIsNone(corner_position(screen, obstacles))
        self.assertIsNone(corner_position((0, 0, 540, 540), []))

    def test_arrow_obstacle_and_margin(self):
        self.assertEqual(corner_position((0, 0, 2560, 1440), [(2010, 880, 20, 65)]), (26, 894))
        self.assertFalse(overlaps((0, 0, 520, 520), (533, 0, 10, 10)))
        self.assertEqual(wrap_lines("一二三四\n五六", len, 2), ["一二", "三四", "五六"])


class WidgetTests(unittest.TestCase):
    def setUp(self):
        self.app = CoachOverlay(parse_args(["--rect", "600", "600", "120", "60", "--text", "测试",
                                           "--whale", "--no-panel", "--no-sound"]))
        self.app.steps = [{"text": "测试", "rect": [600, 600, 120, 60]}] * 3

    def tearDown(self):
        self.app.close()

    def test_long_text_and_native_controls(self):
        app = self.app
        for text in ("点击“文件”菜单", "选择“新建空白文档”\n开始一个新的工作区", "长步骤测试" * 60,
                     "W" * 240, "第一行\n第二行\n第三行"):
            app._update_whale_text(text)
            rendered = app.whale_canvas.itemcget(app._whale_text_id, "text")
            self.assertLessEqual(len(rendered.splitlines()), 2)
            for line in rendered.splitlines():
                self.assertLessEqual(app._step_font.measure(line), 292)
            bounds = app.whale_canvas.bbox(app._whale_text_id)
            self.assertGreater(bounds[1], 85)
            self.assertLess(bounds[3], 160)
        for hwnd in (app.whale_button_hwnd, app.whale_close_hwnd):
            style = get_window_long(hwnd, GWL_EXSTYLE)
            self.assertTrue(style & WS_EX_NOACTIVATE)
            self.assertFalse(style & WS_EX_TRANSPARENT)
        self.assertTrue(get_window_long(app.hwnd, GWL_EXSTYLE) & WS_EX_TRANSPARENT)

    def test_drawing_reuse_and_fallback(self):
        app = self.app
        app._draw((600, 600, 120, 60), "测试")
        items = app.canvas.find_all()
        app._draw((600, 600, 120, 60), "测试")
        self.assertEqual(app.canvas.find_all(), items)
        self.assertTrue(app._whale_allowed)
        app._draw((0, 0, 2560, 1440), "四角无空间")
        self.assertFalse(app._whale_allowed)


if __name__ == "__main__":
    unittest.main()
