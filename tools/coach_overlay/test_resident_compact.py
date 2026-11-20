"""Local Tk regressions; fake channel, no API, capture or OS input."""
import time
import unittest
from types import SimpleNamespace
from resident_panel import ResidentPanel
from resident_compact import IDLE_SECONDS, BAR_HEIGHT


class Channel:
    def __init__(self):
        self.events = []
    def ready(self): pass
    def heartbeat(self): pass
    def messages(self): return []
    def state(self): return {"mode": "standby", "task": None}
    def send(self, kind, payload): self.events.append((kind, payload))


class CompactTests(unittest.TestCase):
    def setUp(self):
        self.channel = Channel()
        self.panel = ResidentPanel(self.channel, no_sound=True)

    def tearDown(self):
        self.panel._force_close()

    def test_feed_bound_and_expiry(self):
        view = self.panel.compact
        for text in ("第一句", "第二句", "第三句"):
            view.append(text)
        self.assertEqual(view.messages, ["第二句", "第三句"])
        self.assertLessEqual(len(view.fit("很长的文本" * 100).splitlines()), 2)
        view.last_message_at = time.monotonic() - IDLE_SECONDS - 1
        view.tick()
        self.assertEqual(view.feed.state(), "withdrawn")
        self.assertIsNone(self.panel.whale)

    def test_send_and_task_controls_keep_protocol(self):
        panel = self.panel
        panel._entry.insert(0, "教我打开菜单")
        panel._submit_chat()
        self.assertIn(("chat_submit", {"text": "教我打开菜单"}), self.channel.events)
        task = {"task_id": "t", "step_index": 0, "steps": ["打开菜单", "选择选项"], "status": "waiting_user"}
        panel._apply_state({"task": task})
        panel._apply_state({"task": task})
        self.assertTrue(panel.compact.expanded)
        panel.compact.check.invoke()
        self.assertIn(("check_step", {}), self.channel.events)
        panel.compact.last_message_at = time.monotonic() - IDLE_SECONDS - 1
        panel._apply_state({"task": task})
        self.assertFalse(panel.compact.expanded)
        panel._request_close()
        self.assertIn(("close_assistant", {}), self.channel.events)

    def test_capsule_release_and_keyboard(self):
        view = self.panel.compact
        self.panel.root.update_idletasks()
        calls = []
        view.send.command = lambda: calls.append("send")
        view.send.press(None)
        view.send.release(SimpleNamespace(x=-1, y=10))
        self.assertEqual(calls, [])
        view.send.press(None)
        view.send.release(SimpleNamespace(x=20, y=10))
        self.assertEqual(calls, ["send"])
        view.send.key_press(None)
        view.send.key_press(None)  # Auto-repeat must not submit repeatedly.
        view.send.key_release(None)
        view.send.key_release(None)
        self.assertEqual(calls, ["send", "send"])
        view.send.key_press(None)
        view.send.lose_focus(None)
        view.send.key_release(None)
        self.assertEqual(calls, ["send", "send"])

    def test_bubbles_remain_bounded(self):
        view = self.panel.compact
        for i in range(12):
            view.messages = ["旧消息" * (i + 1), "新消息" * (i + 2)]
            view.draw()
            self.assertEqual(len(view.visible_bubble_textures), 2)
            self.assertLessEqual(len(view.bubble_textures), 8)
        for line in view.fit("很长的文字" * 100).splitlines():
            self.assertLessEqual(view.font.measure(line), 496)


if __name__ == "__main__":
    import sys
    if "--preview" in sys.argv:
        panel = ResidentPanel(Channel(), no_sound=True)
        panel.root.after(1500, lambda: panel.compact.append("我会在这里陪你，有需要随时告诉我。"))
        panel.root.after(4500, lambda: panel.compact.append("新的消息出现后，上一条会轻轻上移。"))
        panel.root.after(9000, lambda: panel.compact.append("只保留最近两条，安静时自动收起。"))
        panel.root.after(35000, panel._force_close)
        panel.run()
    else:
        unittest.main()
