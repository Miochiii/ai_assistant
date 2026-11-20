"""Measure real Tk text against callout backgrounds without showing a window."""
import tkinter as tk
from tkinter import font as tkfont
import unittest

from coach_overlay import CoachOverlay


class CalloutLayoutTests(unittest.TestCase):
    def setUp(self):
        self.root = tk.Tk()
        self.root.withdraw()
        self.app = CoachOverlay.__new__(CoachOverlay)
        self.app.canvas = tk.Canvas(self.root)
        self.app.font_family = 'Microsoft YaHei'
        self.app.label_font = tkfont.Font(self.root, family=self.app.font_family,
                                         size=18, weight='bold')

    def tearDown(self):
        self.root.destroy()

    def check_layout(self, text, screen=(1280, 720), target=(580, 300, 120, 60)):
        app = self.app
        app.virtual = (0, 0, *screen)
        app.canvas.delete('all')
        app._draw_callout(*target, text, '#00E5FF')
        box = app.canvas.coords(app.canvas.find_withtag('callout-background')[0])
        label = app.canvas.find_withtag('callout-text')[0]
        bounds = app.canvas.bbox(label)
        self.assertGreaterEqual(bounds[0], box[0] + 60)
        self.assertGreaterEqual(bounds[1], box[1] + 12)
        self.assertLessEqual(bounds[2], box[2] - 12)
        self.assertLessEqual(bounds[3], box[3] - 12)
        self.assertGreaterEqual(box[0], 12)
        self.assertGreaterEqual(box[1], 12)
        self.assertLessEqual(box[2], screen[0] - 12)
        self.assertLessEqual(box[3], screen[1] - 12)
        return app.canvas.itemcget(label, 'text')

    def test_wrapped_and_multiline_text_stays_inside_background(self):
        for text in ('点击“文件”菜单', '点击上方的设置按钮并选择需要调整的选项。' * 12,
                     'W' * 240, '第一步\n找到设置\n然后打开高级选项\n检查结果'):
            with self.subTest(text=text[:20]):
                self.assertEqual(self.check_layout(text), text)

    def test_narrow_screen_edges_and_large_font(self):
        self.app.label_font.configure(size=26)
        for target in ((0, 0, 100, 50), (480, 420, 100, 50), (200, 160, 160, 150)):
            with self.subTest(target=target):
                self.check_layout('请打开设置并查看下一个选项。' * 8, (640, 480), target)

    def test_extreme_height_uses_visible_ellipsis(self):
        rendered = self.check_layout('一行\n' * 100, (640, 480))
        self.assertTrue(rendered.endswith('…'))


if __name__ == '__main__':
    unittest.main()
