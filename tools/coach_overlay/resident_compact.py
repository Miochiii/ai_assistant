"""Compact resident presentation. No capture, model or desktop input calls."""
import time
import math
import tkinter as tk
import tkinter.font as tkfont

from coach_overlay import (CHROMA, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
                           WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
                           get_window_long, set_window_long, root_window,
                           user32, gdi32, wrap_lines)

WIDTH = 560
BAR_HEIGHT = 64
TASK_HEIGHT = 108
FEED_HEIGHT = 168
IDLE_SECONDS = 12
BLUE = "#D5E5F5"
INK = "#284467"
MUTED = "#6B83A3"
ENTRY_BG = "#E7F2FB"


def rounded_rect(canvas, bounds, radius=16, **style):
    # Match the circular corners of the RGB texture rather than a spline box.
    x, y, right, bottom = bounds
    radius = max(1, min(radius, (right - x) / 2, (bottom - y) / 2))
    points = []
    for cx, cy, start in ((right - radius, y + radius, -90),
                          (right - radius, bottom - radius, 0),
                          (x + radius, bottom - radius, 90),
                          (x + radius, y + radius, 180)):
        for step in range(13):
            angle = math.radians(start + step * 7.5)
            points.extend((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return canvas.create_polygon(points, **style)


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def surface_color(x, y):
    """Decorative glass, without reading the screen behind the window."""
    color = mix((166, 220, 247), (232, 204, 236), min(1, max(0, x / WIDTH)))
    return mix(color, (247, 251, 255), .30 + .23 * max(0, 1 - y / BAR_HEIGHT))


def glass_image(master, width, height, radius, colors=None, origin=(0, 0), transparent=False):
    """Small cached RGB texture; rounded clipping uses the existing color key."""
    chroma = tuple(int(CHROMA[i:i + 2], 16) for i in (1, 3, 5))
    pixels = bytearray()
    for y in range(height):
        for x in range(width):
            dx = max(radius - x - .5, x + .5 - (width - radius), 0)
            dy = max(radius - y - .5, y + .5 - (height - radius), 0)
            outside = math.hypot(dx, dy) > radius
            if outside and transparent:
                color = chroma
            elif colors is None or outside:
                color = surface_color(x + origin[0], y + origin[1])
            else:
                color = mix(*colors, x / max(1, width - 1))
                color = mix(color, (255, 255, 255), .28 * max(0, 1 - y / max(1, height * .65)))
            pixels.extend(color)
    return tk.PhotoImage(master=master, data=f"P6\n{width} {height}\n255\n".encode() + pixels, format="PPM")


class GlassButton(tk.Canvas):
    """Painted capsule with mouse release and keyboard activation semantics."""
    def __init__(self, parent, text, command, family):
        super().__init__(parent, highlightthickness=0, bd=0, takefocus=True, cursor="hand2")
        self.text, self.command, self.family = text, command, family
        self.pressed = False
        self.hover = False
        self.texture = None
        self.texture_key = None
        self.bind("<Configure>", self.paint)
        self.bind("<Enter>", lambda _: self.set_hover(True))
        self.bind("<Leave>", lambda _: self.set_hover(False))
        self.bind("<ButtonPress-1>", self.press)
        self.bind("<ButtonRelease-1>", self.release)
        self.bind("<FocusIn>", self.paint)
        self.bind("<FocusOut>", self.lose_focus)
        self.bind("<KeyPress-space>", self.key_press)
        self.bind("<KeyRelease-space>", self.key_release)
        self.bind("<Return>", lambda _: self.invoke())

    def invoke(self):
        return self.command()

    def set_hover(self, value):
        self.hover = value
        self.paint()

    def press(self, event):
        self.focus_set()
        self.pressed = True
        self.paint()

    def release(self, event):
        invoke = self.pressed and 0 <= event.x < self.winfo_width() and 0 <= event.y < self.winfo_height()
        self.pressed = False
        self.paint()
        if invoke:
            self.invoke()

    def key_press(self, event):
        self.pressed = True
        self.paint()
        return "break"

    def key_release(self, event):
        invoke = self.pressed
        self.pressed = False
        self.paint()
        if invoke:
            self.invoke()
        return "break"

    def lose_focus(self, event):
        self.pressed = False
        self.paint()

    def paint(self, event=None):
        w, h = self.winfo_width(), self.winfo_height()
        if w < 3 or h < 3:
            return
        key = (w, h, self.winfo_x(), self.winfo_y(), self.hover, self.pressed)
        if key != self.texture_key:
            colors = ((142, 205, 239), (176, 185, 231)) if self.pressed else (
                ((171, 224, 249), (205, 211, 246)) if self.hover else ((193, 232, 250), (215, 215, 245)))
            self.texture = glass_image(self, w, h, h / 2, colors, (key[2], key[3]))
            self.texture_key = key
        self.delete("all")
        self.create_image(0, 0, image=self.texture, anchor="nw")
        rounded_rect(self, (1, 2, w - 2, h - 1), radius=h / 2 - 2,
                     outline="#91A7CD", width=1, fill="")
        rounded_rect(self, (2, 1, w - 3, h - 3), radius=h / 2 - 3,
                     outline="#F6FCFF", width=1, fill="")
        if self.focus_get() == self:
            rounded_rect(self, (4, 4, w - 5, h - 5), radius=h / 2 - 5,
                         outline="#527EB3", width=1, fill="")
        self.create_text(w / 2, h / 2 + int(self.pressed), text=self.text,
                         fill=INK, font=(self.family, -16))


class CompactMenu:
    """Stable custom overlay menu.

    The native tk_popup menu flickered on this overrideredirect/topmost panel
    whenever grab handling raced the button release. A plain Toplevel with no
    grab keeps the menu visible until an item or the panel is clicked.
    """
    def __init__(self, panel, items, exclude=None):
        self.panel = panel
        self.items = items
        self.window = tk.Toplevel(panel)
        self.window.withdraw()
        self.window.overrideredirect(True)
        self.window.configure(bg=BLUE)
        self.window.attributes("-topmost", True)
        self.width = 236
        self.labels = []
        body = tk.Frame(self.window, bg=BLUE, padx=1, pady=1)
        body.pack(fill="both", expand=True)
        for item in items:
            if item is None:
                tk.Frame(body, bg="#B7D4E8", height=1).pack(fill="x", padx=12, pady=4)
                continue
            label, command = item
            widget = tk.Label(body, text=label, bg=BLUE, fg=INK, anchor="w",
                              padx=16, pady=9, font=("Microsoft YaHei UI", -17))
            widget.pack(fill="x")
            widget.bind("<Enter>", lambda _e, w=widget: w.configure(bg="#B8D8F0"))
            widget.bind("<Leave>", lambda _e, w=widget: w.configure(bg=BLUE))
            widget.bind("<Button-1>", lambda _e, c=command: self._choose(c))
            self.labels.append(widget)
        self.height = body.winfo_reqheight() + 2
        self.window.protocol("WM_DELETE_WINDOW", self.close)
        panel.bind("<Button-1>", lambda _e: self.close(), add="+")
        if exclude:
            try:
                exclude(root_window(self.window))
            except Exception:
                pass

    def set_label(self, index, text):
        if 0 <= index < len(self.labels):
            self.labels[index].configure(text=text)

    def _choose(self, command):
        self.close()
        command()

    def open_at(self, x, y):
        self.window.update_idletasks()
        height = max(40, self.window.winfo_reqheight() + 2)
        self.window.geometry(f"{self.width}x{height}{x:+d}{y - height - 8:+d}")
        self.window.deiconify()
        self.window.lift()
        self.window.attributes("-topmost", True)
        try:
            user32.SetWindowPos(root_window(self.window), -1, x, y - height - 8,
                                self.width, height, 0x0010)
        except Exception:
            pass

    def close(self):
        try:
            self.window.withdraw()
        except tk.TclError:
            pass


class CompactView:
    def __init__(self, owner):
        self.owner = owner
        self.messages = []
        self.last_message_at = 0.0
        self.animation = 0
        self.expanded = False
        self.task_key = None
        self.panel_textures = {}
        self.bubble_textures = {}
        self.position = (owner.virtual[0] + owner.virtual[2] - WIDTH - 28,
                         owner.virtual[1] + owner.virtual[3] - BAR_HEIGHT - 64)
        self.panel = tk.Toplevel(owner.root)
        self.panel.withdraw()
        self.panel.title("鲸鱼助手 · 输入")
        self.panel.overrideredirect(True)
        self.panel.configure(bg=BLUE)
        self.panel.attributes("-topmost", True)
        self.panel.attributes("-alpha", .98)
        self.canvas = tk.Canvas(self.panel, bg=BLUE, bd=0, highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.entry = tk.Entry(self.panel, bg=ENTRY_BG, fg=INK, insertbackground="#5176AB",
                              selectbackground="#ACCDEB", selectforeground=INK,
                              relief="flat", bd=0, font=(owner.font_family, -19))
        self.entry.place(x=40, y=19, width=366, height=28)
        self.entry.bind("<Return>", owner._submit_chat)
        self.entry.bind("<KeyPress>", owner._on_typing)
        self.entry.bind("<FocusOut>", lambda _: owner._typing_ended())
        self.entry.bind("<FocusIn>", lambda _: self.hint.place_forget())
        self.hint = tk.Label(self.panel, text="和我说点什么…", bg=ENTRY_BG, fg=MUTED,
                             font=(owner.font_family, -19), anchor="w", bd=0)
        self.hint.place(x=40, y=19, width=360, height=28)
        self.hint.bind("<Button-1>", lambda _: owner._focus_chat())
        self.send = self.button("发送 ↑", owner._submit_chat)
        self.send.place(x=428, y=13, width=82, height=38)
        self.menu = CompactMenu(self.panel, [
            ("暂停观察", owner._toggle_observation),
            ("停止这次回答", lambda: self.control("stop_response")),
            ("结束当前任务", lambda: self.control("end_task")),
            None,
            ("回看最近两条", self.reveal),
            ("检查当前步骤", owner._check_step),
            ("跳过（未验证）", owner._skip_step),
            ("关闭助手", owner._request_close),
        ], exclude=owner._exclude_window)
        self.more = self.button("⋯", self.open_menu)
        self.more.place(x=518, y=15, width=32, height=34)
        self.check = self.button("检查下一步 ✓", owner._check_step)
        self.skip = self.button("跳过", owner._skip_step)
        self.task_label = tk.Label(self.panel, text="", bg=BLUE, fg=INK,
                                   font=(owner.font_family, -18), anchor="w", justify="left")
        self.status_var = tk.StringVar(value="待命")

        self.feed = tk.Toplevel(owner.root)
        self.feed.withdraw()
        self.feed.title("鲸鱼助手 · 消息")
        self.feed.overrideredirect(True)
        self.feed.configure(bg=CHROMA)
        self.feed.attributes("-topmost", True)
        self.feed.attributes("-transparentcolor", CHROMA)
        self.feed_canvas = tk.Canvas(self.feed, bg=CHROMA, highlightthickness=0, bd=0)
        self.feed_canvas.pack(fill="both", expand=True)
        self.font = tkfont.Font(owner.root, family=owner.font_family, size=-20)
        self.panel.update_idletasks()
        self.feed.update_idletasks()
        self.hwnd = root_window(self.panel)
        self.feed_hwnd = root_window(self.feed)
        for hwnd, flags in ((self.hwnd, WS_EX_TOOLWINDOW),
                            (self.feed_hwnd, WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT)):
            set_window_long(hwnd, GWL_EXSTYLE, get_window_long(hwnd, GWL_EXSTYLE) | flags)
            owner._exclude_window(hwnd)
        self.canvas.bind("<ButtonPress-1>", self.drag_start)
        self.canvas.bind("<B1-Motion>", self.drag_move)
        self.layout()

    def button(self, text, command):
        return GlassButton(self.panel, text, command, self.owner.font_family)

    def control(self, kind):
        try:
            self.owner.channel.send(kind, {})
        except Exception as error:
            self.owner._set_status(f"请求失败：{error}")

    def open_menu(self):
        try:
            self.menu.open_at(self.panel.winfo_rootx() + WIDTH - 252,
                              self.panel.winfo_rooty())
        except Exception as error:
            self.owner._set_status(f"菜单打开失败：{error}")

    def drag_start(self, event):
        self.drag_origin = (event.x_root, event.y_root, *self.position)

    def drag_move(self, event):
        if not hasattr(self, "drag_origin"):
            return
        px, py, x, y = self.drag_origin
        sx, sy, sw, sh = self.owner.virtual
        height = TASK_HEIGHT if self.expanded else BAR_HEIGHT
        self.position = (max(sx + 12, min(sx + sw - WIDTH - 12, x + event.x_root - px)),
                         max(sy + FEED_HEIGHT + 16, min(sy + sh - height - 12, y + event.y_root - py)))
        self.layout()

    def layout(self):
        x, y = self.position
        height = TASK_HEIGHT if self.expanded else BAR_HEIGHT
        self.panel.geometry(f"{WIDTH}x{height}{x:+d}{y:+d}")
        self.feed.geometry(f"{WIDTH}x{FEED_HEIGHT}{x:+d}{y - FEED_HEIGHT - 8:+d}")
        user32.SetWindowPos(self.hwnd, -1, x, y, WIDTH, height, 0x0010)
        user32.SetWindowPos(self.feed_hwnd, -1, x, y - FEED_HEIGHT - 8, WIDTH, FEED_HEIGHT, 0x0010)
        region = gdi32.CreateRoundRectRgn(0, 0, WIDTH + 1, height + 1, 28, 28)
        if region and not user32.SetWindowRgn(self.hwnd, region, True):
            gdi32.DeleteObject(region)
        self.canvas.delete("all")
        if height not in self.panel_textures:
            self.panel_textures[height] = glass_image(self.panel, WIDTH, height, 16)
        self.canvas.create_image(0, 0, anchor="nw", image=self.panel_textures[height])
        rounded_rect(self.canvas, (1, 1, WIDTH - 2, height - 2), radius=16,
                     fill="", outline="#8FA8CA", width=1)
        rounded_rect(self.canvas, (3, 2, WIDTH - 4, height - 4), radius=15,
                     fill="", outline="#F5FCFF", width=2)
        rounded_rect(self.canvas, (30, 11, 416, 53), radius=18,
                     fill=ENTRY_BG, outline="#F5FBFF", width=1)
        self.canvas.create_text(18, 32, text="⠿", fill=MUTED, font=(self.owner.font_family, -20))
        if self.expanded:
            self.canvas.create_line(18, 62, WIDTH - 18, 62, fill="#F0F6FF")
            rounded_rect(self.canvas, (12, 68, 325, 101), radius=12, fill=BLUE, outline="")

    def fit(self, text):
        lines = wrap_lines(" ".join(text.split()), self.font.measure, WIDTH - 64)
        if len(lines) > 2:
            last = lines[1]
            while last and self.font.measure(last + "…") > WIDTH - 64:
                last = last[:-1]
            lines = [lines[0], last + "…"]
        return "\n".join(lines)

    def append(self, text):
        self.messages = (self.messages + [text])[-2:]
        self.last_message_at = time.monotonic()
        self.animation += 1
        token = self.animation
        self.feed.attributes("-alpha", 1.0)
        self.feed.deiconify()
        user32.ShowWindow(self.feed_hwnd, 4)
        self.layout()
        def frame(step=0):
            if self.owner._closed or token != self.animation:
                return
            self.draw(step / 8)
            if step < 8:
                self.owner.root.after(24, lambda: frame(step + 1))
        frame()

    def draw(self, progress=1):
        c = self.feed_canvas
        c.delete("all")
        self.visible_bubble_textures = []
        for index, text in enumerate(self.messages):
            old = len(self.messages) == 2 and index == 0
            # Previous bubble rises; its text softens without painting the desktop.
            y = (121 - 80 * progress) if old else 121 + 10 * (1 - progress)
            color = ("#%02x%02x%02x" % tuple(round(a + (b - a) * progress)
                     for a, b in zip((40, 68, 103), (112, 132, 160)))) if old else INK
            body = self.fit(text)
            lines = body.splitlines() or [""]
            width = min(WIDTH - 16, max(100, max(self.font.measure(line) for line in lines) + 40))
            height = min(72, len(lines) * self.font.metrics("linespace") + 22)
            key = (width, height, old)
            if key not in self.bubble_textures:
                # Keep only the live pair and transitional textures, not chat history.
                if len(self.bubble_textures) >= 8:
                    self.bubble_textures.clear()
                colors = ((222, 237, 248), (235, 225, 243)) if old else ((190, 226, 247), (228, 210, 240))
                self.bubble_textures[key] = glass_image(self.feed, width, height, 17, colors, transparent=True)
            x, top = WIDTH - width - 8, y - height / 2
            rounded_rect(c, (x, top + 3, x + width, top + height + 3), radius=17,
                         fill="#8E9EBB", outline="")
            texture = self.bubble_textures[key]
            self.visible_bubble_textures.append(texture)
            c.create_image(x, top, anchor="nw", image=texture)
            rounded_rect(c, (x + 1, top + 1, x + width - 2, top + height - 2), radius=16,
                         fill="", outline="#F5FBFF", width=1)
            c.create_text(x + 20, y, anchor="w", text=body, font=self.font, fill=color, justify="left")

    def reveal(self):
        if self.messages:
            self.last_message_at = time.monotonic()
            self.feed.attributes("-alpha", 1)
            self.feed.deiconify()
            self.draw()

    def tick(self):
        age = time.monotonic() - self.last_message_at
        if age >= IDLE_SECONDS + .6:
            self.feed.withdraw()
        elif age >= IDLE_SECONDS:
            self.feed.attributes("-alpha", max(0, 1 - (age - IDLE_SECONDS) / .6))
        if not self.entry.get() and self.panel.focus_get() != self.entry:
            self.hint.place(x=40, y=19, width=360, height=28)
        else:
            self.hint.place_forget()

    def task(self, task):
        key = None if not task else (task.get("task_id"), task.get("step_index"), task.get("text"), task.get("status"))
        expanded = bool(task) and (time.monotonic() - self.last_message_at < IDLE_SECONDS
                                   or self.panel.focus_get() == self.entry)
        if expanded != self.expanded:
            # Keep bottom edge stable as the compact task row appears/disappears.
            self.position = (self.position[0], self.position[1] + (BAR_HEIGHT - TASK_HEIGHT if expanded else TASK_HEIGHT - BAR_HEIGHT))
            self.expanded = expanded
            self.layout()
        if task:
            steps = task.get("steps") or []
            index = max(0, min(int(task.get("step_index", 0)), max(0, len(steps) - 1)))
            text = task.get("text") or (steps[index] if steps else "检查当前步骤")
            text = str(text)
            short = text[:15] + ("…" if len(text) > 15 else "")
            self.task_label.configure(text=f"{index + 1}/{max(1, len(steps))}  {short}")
            if expanded:
                self.task_label.place(x=18, y=72, width=305, height=26)
                self.check.place(x=334, y=70, width=150, height=28)
                self.skip.place(x=493, y=70, width=50, height=28)
            else:
                for widget in (self.task_label, self.check, self.skip):
                    widget.place_forget()
            if key != self.task_key:
                self.append(text)
        else:
            for widget in (self.task_label, self.check, self.skip):
                widget.place_forget()
        self.task_key = key
