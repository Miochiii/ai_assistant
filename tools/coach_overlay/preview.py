"""Local visual fixture. No target-app reads/inputs; closes after 5 minutes.

Run with the same Python 3.12 as coach_overlay.py. The only interactive
controls are Coach's Next/Close. The background is deliberately a mock page.
"""
import json
import sys
import tkinter as tk

from coach_overlay import CoachOverlay, parse_args, root_window, window_rect, user32


class Preview(CoachOverlay):
    def __init__(self):
        flags = ["--rect", "160", "160", "120", "48", "--text", "点击文件菜单",
                 "--whale", "--no-panel", "--no-sound", "--max-age", "0", "--seconds", "300"]
        if "--exclude-capture" in sys.argv:
            flags.append("--exclude-capture")
        super().__init__(parse_args(flags))
        self.root.title("Coach Overlay · 验收")
        self.fixture = tk.Toplevel(self.root)
        self.fixture.title("Coach Preview · 本地模拟桌面")
        self.fixture.attributes("-fullscreen", True)
        self.fixture.geometry(f"{self.virtual[2]}x{self.virtual[3]}+0+0")
        canvas = tk.Canvas(self.fixture, bg="#F0F4FA", bd=0, highlightthickness=0)
        canvas.pack(fill="both", expand=True)
        canvas.create_rectangle(0, 0, 2560, 88, fill="#0B1736", outline="")
        canvas.create_text(64, 44, text="COACH  /  视觉验收", anchor="w", fill="#F7FBFF",
                           font=(self.font_family, -24, "bold"))
        canvas.create_text(2496, 44, text="LOCAL PREVIEW · 无应用输入", anchor="e", fill="#8FA6D6",
                           font=(self.font_family, -18))
        canvas.create_rectangle(80, 120, 1800, 1180, fill="#FFFFFF", outline="#DCE4F0", width=2)
        canvas.create_rectangle(80, 120, 1800, 240, fill="#F7FBFF", outline="")
        for x, label in ((160, "文件"), (310, "编辑"), (460, "查看")):
            canvas.create_rectangle(x, 160, x + 120, 208, fill="#EAF1FB", outline="#CCD9EC")
            canvas.create_text(x + 60, 184, text=label, fill="#35508F", font=(self.font_family, -22))
        canvas.create_text(160, 310, text="示例工作区", fill="#0B1736", anchor="w",
                           font=(self.font_family, -32, "bold"))
        canvas.create_text(160, 365, text="此页面仅用于验收提示层，不是正在操作的软件。", anchor="w",
                           fill="#6B7FAE", font=(self.font_family, -22))
        canvas.create_rectangle(180, 500, 560, 560, fill="#F7FBFF", outline="#8FA6D6")
        canvas.create_text(370, 530, text="新建空白文档", fill="#35508F", font=(self.font_family, -22))
        canvas.create_text(160, 1080, text="在鲸鱼气泡中点击「下一步」查看下一个提示。", anchor="w",
                           fill="#6B7FAE", font=(self.font_family, -20))
        self.fixture.update_idletasks()
        self.fixture_hwnd = root_window(self.fixture)
        self._previous_foreground = self.fixture_hwnd
        self.preview_state = {
            "generation": 1, "target_hwnd": self.fixture_hwnd,
            "window_rect": list(window_rect(self.fixture_hwnd)),
            "steps": [{"rect": [160, 160, 120, 48], "text": "点击“文件”菜单"},
                      {"rect": [180, 500, 380, 60], "text": "选择“新建空白文档”\n开始一个新的工作区"},
                      {"rect": [160, 300, 450, 90], "text": "检查新建的工作区"}]}
        self.root.after(250, self._report)

    def _state(self):
        return getattr(self, "preview_state", None)

    def _report(self):
        if self._closed:
            return
        record = {"step": self.step_index + 1, "foreground": int(user32.GetForegroundWindow() or 0),
                  "fixture_hwnd": self.fixture_hwnd, "overlay_hwnd": self.hwnd,
                  "whale_hwnd": self.whale_hwnd, "button_hwnd": self.whale_button_hwnd,
                  "close_hwnd": self.whale_close_hwnd, "visible": self.visible,
                  "whale_visible": self._whale_visible, "position": self._whale_pos,
                  "font_pixels": abs(self._step_font.cget("size")),
                  "rendered_text": self.whale_canvas.itemcget(self._whale_text_id, "text")}
        print(json.dumps(record, ensure_ascii=False), flush=True)
        self.root.after(2000, self._report)


if __name__ == "__main__":
    Preview().run()
