"""Compact resident assistant panel for RH03.

This is a display/input shell only. It uses a two-message transparent feed and
a compact input bar, reads the Node Host's state/outbox, and appends
user events to inbox. It does not capture the screen, call a model or execute
desktop input.
"""
from __future__ import annotations

import argparse
import sys
import time
import tkinter as tk
from pathlib import Path

from coach_overlay import (
    CoachOverlay,
    GWL_EXSTYLE,
    WS_EX_TOOLWINDOW,
    get_window_long,
    parse_args,
    root_window,
    set_window_long,
    user32,
)

from resident_channel import ResidentChannel
from resident_compact import CompactView



class ResidentPanel(CoachOverlay):
    def __init__(self, channel: ResidentChannel, *, no_sound: bool = False,
                 exclude_capture: bool = False) -> None:
        flags = [
            "--rect", "0", "0", "1", "1",
            "--text", "待命中",
            "--no-panel",
            "--max-age", "0",
            "--seconds", "0",
        ]
        if no_sound:
            flags.append("--no-sound")
        if exclude_capture:
            flags.append("--exclude-capture")
        super().__init__(parse_args(flags))
        self.channel = channel
        self._resident_state: dict = {}
        self._last_revision = -1
        self._seen_messages: set[str] = set()
        self._closing = False
        self._typing_started = False
        self._typing_timer = None
        self._last_heartbeat = 0.0
        self._last_status = ""
        self._create_chat_panel()
        self.channel.ready()
        self._show_chat_panel()

    # ---- lifecycle -----------------------------------------------------
    def _request_close(self) -> None:
        if self._closing:
            return
        self._closing = True
        self._set_status("正在关闭…")
        try:
            self.channel.send("close_assistant", {})
        except Exception as error:
            self._append_message("系统", f"关闭事件发送失败：{error}")
        self.root.after(1200, self._force_close)

    def _force_close(self) -> None:
        if getattr(self, "_closed", False):
            return
        try:
            super().close()
        except Exception:
            pass

    def _tick(self) -> None:
        if getattr(self, "_closed", False):
            return
        try:
            state = self.channel.state() or {}
            if state.get("assistant") == "closed":
                self._force_close()
                return
            if self._closing:
                self.root.after(120, self._tick)
                return
            self._apply_state(state)
            self._drain_messages()
            now = time.monotonic()
            if now - self._last_heartbeat > 2.0:
                self._last_heartbeat = now
                self.channel.heartbeat()
            self._set_visible(False)
            self._set_whale_visible(False)
            self.compact.tick()
        except Exception as error:
            if self.debug:
                print(f"resident tick failed: {error}", file=sys.stderr, flush=True)
        self.root.after(150, self._tick)

    def close(self) -> None:
        self._request_close()

    # ---- whale presentation -------------------------------------------
    def _update_whale_text(self, text: str | None = None) -> None:
        # Called from the inherited whale show path; state may not exist yet.
        if self.whale is None:
            return
        state = getattr(self, "_resident_state", {}) or {}
        task = state.get("task") if isinstance(state.get("task"), dict) else None
        body = text or (task.get("text") if task else "待命中 · 随时可以聊")
        self.whale_canvas.itemconfigure(self._whale_text_id, text=body[:180])
        if getattr(self, "_progress_id", None):
            self.whale_canvas.itemconfigure(self._progress_id, text="COACH" if task else "待命")
        if getattr(self, "_whale_button", None):
            self._whale_button.itemconfigure(
                self._whale_button.control_label,
                text="检查  ✓" if task else "聊一聊  →")

    def _whale_next(self) -> None:
        state = self._resident_state
        task = state.get("task") if isinstance(state.get("task"), dict) else None
        if not task:
            self._focus_chat()
            return
        if self._closing:
            return
        try:
            self.channel.send("check_step", {})
            self._play_whale_sound()
            self._whale_pop()
            self._set_status("已请求检查当前步骤")
        except Exception as error:
            self._set_status(f"请求失败：{error}")

    # ---- chat panel ----------------------------------------------------
    def _create_chat_panel(self) -> None:
        self.compact = CompactView(self)
        self.chat_panel = self.compact.panel
        self.chat_panel_hwnd = self.compact.hwnd
        self._entry = self.compact.entry
        self._status_var = self.compact.status_var
        self._append_message("助手", "我在这里，随时可以聊。")

    def _place_chat_panel(self) -> None:
        self.compact.layout()

    def _show_chat_panel(self) -> None:
        self.chat_panel.deiconify()
        self.chat_panel.update_idletasks()
        self.compact.layout()
        user32.ShowWindow(self.chat_panel_hwnd, 4)
        self._restore_target_foreground()

    def _focus_chat(self) -> None:
        if not self.chat_panel:
            return
        self.chat_panel.deiconify()
        self.chat_panel.lift()
        self._entry.focus_set()
        self._entry.icursor("end")

    def _on_typing(self, _event=None) -> None:
        if not self._typing_started and not self._closing:
            self._typing_started = True
            try:
                self.channel.send("typing_started", {})
            except Exception:
                pass
        if self._typing_timer:
            self.root.after_cancel(self._typing_timer)
        self._typing_timer = self.root.after(900, self._typing_ended)

    def _typing_ended(self) -> None:
        self._typing_timer = None
        if not self._typing_started:
            return
        self._typing_started = False
        if not self._closing:
            try:
                self.channel.send("typing_ended", {})
            except Exception:
                pass

    def _submit_chat(self, _event=None):
        text = self._entry.get().strip()
        if not text or self._closing:
            return "break"
        try:
            self.channel.send("chat_submit", {"text": text})
            self._entry.delete(0, "end")
            self._append_message("你", text)
            self._typing_ended()
        except Exception as error:
            self._append_message("系统", f"发送失败：{error}")
        return "break"

    def _check_step(self) -> None:
        if self._closing or not self._resident_state.get("task"):
            return
        try:
            self.channel.send("check_step", {})
            self._set_status("已请求检查当前步骤")
        except Exception as error:
            self._set_status(f"请求失败：{error}")

    def _skip_step(self) -> None:
        if self._closing or not self._resident_state.get("task"):
            return
        try:
            self.channel.send("skip_step", {})
            self._set_status("已跳过（未验证）")
        except Exception as error:
            self._set_status(f"请求失败：{error}")

    def _toggle_observation(self) -> None:
        if self._closing:
            return
        observation = self._resident_state.get("observation") or {}
        kind = "resume_observation" if observation.get("status") == "paused" else "pause_observation"
        try:
            self.channel.send(kind, {})
        except Exception as error:
            self._set_status(f"请求失败：{error}")

    def _toggle_demo_task(self) -> None:
        if self._closing:
            return
        if self._resident_state.get("task"):
            try:
                self.channel.send("end_task", {})
            except Exception as error:
                self._set_status(f"请求失败：{error}")
            return
        try:
            self.channel.send("start_task", {
                "title": "演示任务 A",
                "steps": ["点击“新会话”", "点击“插件”"],
            })
        except Exception as error:
            self._set_status(f"请求失败：{error}")

    # ---- state/messages ------------------------------------------------
    def _apply_state(self, state: dict) -> None:
        if not isinstance(state, dict):
            return
        self._resident_state = state
        if state.get("assistant") == "closed":
            self._force_close()
            return
        task = state.get("task") if isinstance(state.get("task"), dict) else None
        self.compact.task(task)
        observation = state.get("observation") or {}
        paused = observation.get("status") == "paused"
        self.compact.menu.set_label(0, "恢复观察" if paused else "暂停观察")
        self._last_revision = state.get("state_revision", self._last_revision)

    def _drain_messages(self) -> None:
        for message in self.channel.messages():
            message_id = message.get("message_id")
            if not message_id or message_id in self._seen_messages:
                continue
            self._seen_messages.add(message_id)
            text = message.get("text")
            if isinstance(text, str) and text.strip():
                self._append_message("助手", text.strip())

    def _append_message(self, who: str, text: str) -> None:
        # The floating feed is for assistant replies; typing does not evict them.
        if hasattr(self, "compact") and who != "你":
            self.compact.append(text if who == "助手" else f"{who}：{text}")

    def _set_status(self, text: str) -> None:
        if hasattr(self, "compact"):
            self.compact.status_var.set(text)
            self.compact.append(text)


def parse_panel_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resident whale/chat panel (RH03)")
    parser.add_argument("--channel-dir", required=True)
    parser.add_argument("--no-sound", action="store_true")
    parser.add_argument("--exclude-capture", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_panel_args(argv)
    channel = ResidentChannel(args.channel_dir)
    try:
        channel.wait_instance()
        panel = ResidentPanel(channel, no_sound=args.no_sound,
                              exclude_capture=args.exclude_capture)
        panel.run()
        return 0
    except Exception as error:
        print(f"resident-panel: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
