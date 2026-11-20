"""Windows backend for a specifically bound test window; no input methods."""
from pathlib import PureWindowsPath
import json
import os
import shutil
import subprocess

APPLICATIONS = {
    "calculator": {"calculatorapp.exe", "calculator.exe"},
    "notepad": {"notepad.exe"},
}


def process_catalog():
    """Read process metadata through Windows' built-in .NET host.

    Some packaged app processes deny this Python process OpenProcess even for
    limited query. Get-Process exposes the same read-only metadata without
    changing permissions. The command is fixed; no user strings are evaluated.
    """
    shell = shutil.which("pwsh") or os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                                                "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    command = (
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); "
        "@(Get-Process -Name CalculatorApp,Calculator,Notepad,ApplicationFrameHost "
        "-ErrorAction SilentlyContinue | ForEach-Object { "
        "if ($_.Path -and $_.StartTime) { [pscustomobject]@{ "
        "pid=$_.Id; path=$_.Path; started=$_.StartTime.ToUniversalTime().ToString('o') "
        "} } }) | ConvertTo-Json -Compress"
    )
    result = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", command],
                            capture_output=True, text=True, encoding="utf-8-sig", timeout=5,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode != 0:
        raise RuntimeError("PROCESS_METADATA_UNAVAILABLE")
    data = json.loads(result.stdout or "[]")
    if isinstance(data, dict):
        data = [data]
    return {item["pid"]: item for item in data}


def bind_content(hwnd, host_pid, application, catalog, children):
    """Resolve direct or hosted ownership without trusting window titles."""
    host = catalog.get(host_pid)
    if host is None:
        raise ValueError("APPLICATION_NOT_ALLOWED")
    name = PureWindowsPath(host["path"]).name.lower()
    if name in APPLICATIONS[application]:
        return hwnd, host_pid
    if name != "applicationframehost.exe":
        raise ValueError("APPLICATION_NOT_ALLOWED")
    matches = [(handle, pid) for handle, pid, class_name in children
               if class_name == "Windows.UI.Core.CoreWindow" and pid in catalog
               and PureWindowsPath(catalog[pid]["path"]).name.lower() in APPLICATIONS[application]]
    if len(matches) != 1:
        raise ValueError("TARGET_AMBIGUOUS" if matches else "APPLICATION_NOT_ALLOWED")
    return matches[0]


def identity(hwnd, application, expected_pid=None, catalog=None):
    import win32gui
    import win32process

    if application not in APPLICATIONS or not win32gui.IsWindow(hwnd):
        raise ValueError("TARGET_NOT_FOUND")
    catalog = process_catalog() if catalog is None else catalog
    _, host_pid = win32process.GetWindowThreadProcessId(hwnd)
    children = []
    host = catalog.get(host_pid)
    if host and PureWindowsPath(host["path"]).name.lower() == "applicationframehost.exe":
        def child(handle, _):
            if len(children) < 100:
                _, child_pid = win32process.GetWindowThreadProcessId(handle)
                children.append((handle, child_pid, win32gui.GetClassName(handle)))
        win32gui.EnumChildWindows(hwnd, child, None)
    content_hwnd, pid = bind_content(hwnd, host_pid, application, catalog, children)
    if expected_pid is not None and pid != expected_pid:
        raise ValueError("WINDOW_IDENTITY_CHANGED")
    process_name = PureWindowsPath(catalog[pid]["path"]).name.lower()
    started = catalog[pid]["started"]
    if not win32gui.IsWindowVisible(hwnd) or win32gui.IsIconic(hwnd):
        raise ValueError("WINDOW_NOT_VISIBLE")
    return {"hwnd": hwnd, "pid": pid, "content_hwnd": content_hwnd, "host_pid": host_pid,
            "host_started_at": catalog[host_pid]["started"], "application": application,
            "process_name": process_name, "process_started_at": started,
            "title": win32gui.GetWindowText(hwnd)[:256],
            "class_name": win32gui.GetClassName(hwnd)[:128],
            "rectangle": list(win32gui.GetWindowRect(hwnd))}


def list_windows(application):
    import win32gui

    windows = []
    catalog = process_catalog()

    def visit(hwnd, _):
        if len(windows) >= 20:
            return
        try:
            windows.append(identity(hwnd, application, catalog=catalog))
        except Exception:
            pass  # Do not export other applications' titles or contents.

    win32gui.EnumWindows(visit, None)
    matching_processes = [item for item in catalog.values()
                          if PureWindowsPath(item["path"]).name.lower() in APPLICATIONS[application]]
    diagnostics = []
    if not matching_processes:
        diagnostics.append("NO_ALLOWED_PROCESS_METADATA")
    elif not windows:
        diagnostics.append("NO_MATCHING_VISIBLE_WINDOW")
    return {"application": application, "windows": windows, "read_only": True,
            "diagnostics": diagnostics, "matching_process_count": len(matching_processes),
            "limitation": "Only visible allowlisted applications with unique direct/hosted content ownership."}


class UiaNode:
    def __init__(self, info):
        self.info = info

    @property
    def pid(self):
        return self.info.element.CurrentProcessId

    @property
    def password(self):
        return bool(self.info.element.CurrentIsPassword)

    @property
    def visible(self):
        return not self.info.element.CurrentIsOffscreen

    def read(self, text_limit):
        from pywinauto.uia_defines import IUIA, get_elem_interface

        element = self.info.element
        control_type = IUIA().known_control_type_ids.get(element.CurrentControlType, "Unknown")
        text, text_status = "", "not_requested"
        if control_type in {"Edit", "Document"}:
            try:
                pattern = get_elem_interface(element, "Text")
                text = pattern.DocumentRange.GetText(text_limit + 1) or ""
                text_status = "truncated" if len(text) > text_limit else "read"
                text = text[:text_limit]
            except Exception:
                text_status = "unavailable"
        rect = self.info.rectangle
        return {"name": element.CurrentName, "control_type": control_type,
                "automation_id": element.CurrentAutomationId, "text": text, "text_status": text_status,
                "rectangle": [rect.left, rect.top, rect.right, rect.bottom],
                "enabled": bool(element.CurrentIsEnabled), "runtime_id": list(element.GetRuntimeId() or [])}

    def children(self):
        for child in self.info.iter_children():
            yield UiaNode(child)


def observe(hwnd, pid, application):
    import win32gui
    from pywinauto.uia_element_info import UIAElementInfo
    from .snapshot import collect

    before = identity(hwnd, application, pid)
    focus_before = win32gui.GetForegroundWindow()
    snapshot = collect(UiaNode(UIAElementInfo(before["content_hwnd"])), before)
    after = identity(hwnd, application, pid)
    focus_after = win32gui.GetForegroundWindow()
    if after != before or focus_before != focus_after:
        snapshot["issues"].append("WINDOW_OR_FOCUS_CHANGED")
        snapshot["complete"] = False
    snapshot["foreground_at_start"] = focus_before == hwnd
    snapshot["foreground_at_end"] = focus_after == hwnd
    snapshot["observation_limitations"] = [
        "UIA visibility does not prove absence of occlusion.",
        "Snapshot is not atomic; matching fingerprints cannot authorize future input.",
        "No screenshot, clipboard read, keyboard, mouse or focus activation was performed.",
    ]
    return snapshot
