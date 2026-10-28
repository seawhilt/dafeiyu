"""Phase 0 native BigFish helper.

The DSH plugin owns this process and sends newline-delimited JSON over stdin.
Closing stdin is a lifecycle signal: the helper exits instead of becoming an
independent desktop application.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, TextIO

try:
    from .animation_model import Player, crossfade_duration
    from .layout_store import appkit_to_qt_y, default_layout_path, load_layout, pet_position_from_layout, save_layout
    from .asset_paths import bundle_root
    from .pet_geometry import (
        bubble_top, dock_angle, dock_edge, docked_x, position_window, screen_outer_edges, tilt_allowance,
        tilt_for_speed,
    )
except ImportError:
    from animation_model import Player, crossfade_duration
    from layout_store import appkit_to_qt_y, default_layout_path, load_layout, pet_position_from_layout, save_layout
    from asset_paths import bundle_root
    from pet_geometry import (
        bubble_top, dock_angle, dock_edge, docked_x, position_window, screen_outer_edges, tilt_allowance,
        tilt_for_speed,
    )


PROTOCOL_VERSION = 1
STATES = {"IDLE", "THINKING", "WORKING", "WAITING", "SUCCESS", "ERROR", "DISCONNECTED"}
# Speech bubble in dsh-pet's style: a white rounded bubble whose tail points
# at the pet's head. Short lines shrink the bubble to fit.
CARD_WIDTH = 300
BUBBLE_FILL = (244, 244, 246, 248)
BUBBLE_SHADOW = (0, 0, 0, 40)
BUBBLE_TEXT = "#26262B"
BUBBLE_SUBTEXT = "#7A7A84"
BUBBLE_TAIL = (18, 10)
# Transparent headroom above the character's head at the top of every frame;
# the bubble overlaps it so the tail reaches the head.
HEADROOM_PX = 52
# Rounded display fonts, first installed wins.
BUBBLE_FONT_FAMILIES = ["上首软糖体", "ShangShouRuanTangTi", "Yuanti SC", "YouYuan", "PingFang SC", "Microsoft YaHei UI"]
# Fallback right-click "动作" menu for manifests without "actionMenu".
ACTION_MENU = (
    ("摸摸头", "head_pat", "好啦好啦，知道你喜欢我~"),
    ("戳一戳", "poke", "戳我干嘛，任务还在跑呢"),
    ("摸尾巴", "tail", "尾巴不是进度条啦！"),
    ("吃 Token", "eat_token", "Token 真好吃~"),
    ("伸懒腰", "idle_stretch", "伸个懒腰，舒服~"),
    ("打哈欠", "idle_yawn", "啊——有点困了"),
    ("庆祝一下", "success", "耶！"),
)
WHISPER_MENU = (("关闭", "off"), ("偶尔说（15～30 分钟）", "low"), ("话多（5～10 分钟）", "high"))
# A decoded 412x344 ARGB32 frame costs ~0.55 MB, so keeping every frame of a
# 24 fps set resident would need well over a gigabyte. Frames are read from disk
# on demand as compressed bytes and decoded through a bounded cache instead.
DECODED_FRAME_CACHE = 24
# The whale pack is ~14,700 WebP frames (~236 MB). Only this much compressed
# frame data is kept resident; older frames are dropped and re-read when seen.
COMPRESSED_FRAME_CACHE_BYTES = 64 * 1024 * 1024
# Drag lean: how fast it follows the pointer, and how long a pause rights it.
TILT_EASING = 0.2
TILT_SETTLE_S = 0.09


def configure_qt_platform() -> None:
    """Prefer XWayland when available so desktop-window controls keep working."""
    if sys.platform != "linux" or os.environ.get("QT_QPA_PLATFORM"):
        return
    platforms: list[str] = []
    if os.environ.get("DISPLAY"):
        platforms.append("xcb")
    if os.environ.get("WAYLAND_DISPLAY"):
        platforms.append("wayland")
    if platforms:
        os.environ["QT_QPA_PLATFORM"] = ";".join(platforms)


def configure_stdio() -> None:
    """Make the JSONL pipe UTF-8 regardless of the Windows console code page."""
    for stream, errors in ((sys.stdin, "strict"), (sys.stdout, "backslashreplace"), (sys.stderr, "backslashreplace")):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors=errors)


def parse_message(line: str) -> dict[str, Any]:
    message = json.loads(line)
    if not isinstance(message, dict):
        raise ValueError("message must be an object")
    if message.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("unsupported protocol version")
    kind = message.get("kind")
    if kind in {"state", "pulse"} and message.get("state") not in STATES:
        raise ValueError("unsupported companion state")
    return message


def action_menu_groups(manifest: dict[str, Any]) -> list[tuple[str, list[tuple[str, str, str]]]]:
    """Right-click "动作" groups from the manifest, or the flat fallback."""
    groups = []
    for group in manifest.get("actionMenu") or ():
        if not isinstance(group, dict) or not isinstance(group.get("items"), list):
            continue
        entries = [
            (str(item[0]), str(item[1]), str(item[2]))
            for item in group["items"]
            if isinstance(item, list) and len(item) == 3
        ]
        if entries:
            groups.append((str(group.get("label", "")), entries))
    return groups or [("", list(ACTION_MENU))]


def parse_providers(
    message: dict[str, Any],
    current: list[tuple[str, str]],
    current_provider: str,
) -> tuple[list[tuple[str, str]], str]:
    """Read the provider list and active provider from a CONFIG message.

    Fields that are absent keep their current value, so an older host that
    never sends providers leaves the menu unchanged.
    """
    providers = current
    raw = message.get("providers")
    if isinstance(raw, list):
        providers = [
            (str(item["id"]), str(item.get("label") or item["id"]))
            for item in raw
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        ]
    provider = current_provider
    if "provider" in message:
        provider = message["provider"] if isinstance(message["provider"], str) else ""
    return providers, provider


def emit_reply(kind: str, **payload: Any) -> None:
    print(
        json.dumps(
            {"protocolVersion": PROTOCOL_VERSION, "kind": kind, "timestamp": int(time.time() * 1000), **payload},
            ensure_ascii=False,
        ),
        flush=True,
    )


# ---- Glove cursor (native Win32 .cur) ----
def _cursor_api() -> tuple[Any, Any, Any]:
    """Return configured (LoadCursorFromFileW, SetCursor, LoadCursorW) callables.

    Function signatures are declared explicitly so HCURSOR values are handled
    as pointer-sized handles: without argtypes/restype, ctypes treats the
    return value as a C int and truncates 64-bit HCURSORs. wintypes has no
    HCURSOR type, so ``wintypes.HANDLE`` (pointer-sized) is used.
    """
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32

    load_from_file = user32.LoadCursorFromFileW
    load_from_file.argtypes = [wintypes.LPCWSTR]
    load_from_file.restype = wintypes.HANDLE

    set_cursor = user32.SetCursor
    set_cursor.argtypes = [wintypes.HANDLE]
    set_cursor.restype = wintypes.HANDLE

    load_cursor = user32.LoadCursorW
    load_cursor.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR]
    load_cursor.restype = wintypes.HANDLE

    return load_from_file, set_cursor, load_cursor


def load_native_cursor(path: Path) -> Any:
    """Load a .cur cursor with LoadCursorFromFileW (pointer-sized handles).

    Returns None outside Windows or on failure; callers then fall back to the
    Qt default cursor. The resource is loaded at its natural size: per the MSDN
    remarks, LoadCursorFromFileW does not participate in DPI virtualization, so
    the 32x32 .cur is NOT scaled up automatically; the OS renders the cursor
    bitmap on the same pipeline as system cursors.
    """
    if sys.platform != "win32":
        return None
    try:
        handle = _cursor_api()[0](str(path))
        return handle or None
    except Exception:
        return None


def set_native_cursor(handle: Any) -> None:
    """Set the current cursor immediately (bypasses Qt's cursor pipeline)."""
    try:
        _cursor_api()[1](handle)
    except Exception:
        pass


def reset_native_cursor() -> None:
    """Restore the default arrow cursor (IDC_ARROW)."""
    try:
        import ctypes

        # MAKEINTRESOURCE(32512): the identifier is passed as a pointer value.
        arrow = ctypes.cast(ctypes.c_void_p(32512), ctypes.c_wchar_p)
        _cursor_api()[2](None, arrow)
    except Exception:
        pass


class GloveCursorController:
    """Pure state machine for the glove cursor; no Qt or Win32 dependencies.

    ``open_h`` / ``closed_h`` may be None (non-Windows, or the .cur assets are
    missing): every query then returns None, so callers simply fall back to the
    default cursor. This keeps all cursor-state decisions testable.
    """

    WM_LBUTTONDOWN = 0x0201

    def __init__(self, open_h: Any, closed_h: Any) -> None:
        self.open_h = open_h
        self.closed_h = closed_h
        self.pressed = False

    def handle_for(self, closed: bool) -> Any:
        return self.closed_h if closed else self.open_h

    def on_enter(self) -> Any:
        """Pointer entered the pet window: show the open hand."""
        return self.open_h

    def on_leave(self) -> None:
        """Pointer left the pet window: clear the pressed flag, reset to arrow."""
        self.pressed = False
        return None

    def on_press(self) -> Any:
        """Left button pressed: show the closed fist."""
        self.pressed = True
        return self.closed_h

    def on_release(self, inside: bool) -> Any:
        """Left button released: open hand when still inside, otherwise None."""
        self.pressed = False
        return self.open_h if inside else None

    def on_wm_setcursor(self, mouse_msg: int) -> Any:
        """WM_SETCURSOR decision: closed on WM_LBUTTONDOWN (or while pressed)."""
        return self.handle_for(mouse_msg == self.WM_LBUTTONDOWN or self.pressed)


class EventRecorder:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._stream: TextIO | None = None
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._stream = path.open("a", encoding="utf-8")

    def record(self, message: dict[str, Any]) -> None:
        if self._stream is None:
            return
        self._stream.write(json.dumps(message, ensure_ascii=False) + "\n")
        self._stream.flush()

    def close(self) -> None:
        if self._stream is not None:
            self._stream.close()


def run_headless(recorder: EventRecorder) -> int:
    try:
        emit_reply("ready")
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                message = parse_message(line)
            except (ValueError, json.JSONDecodeError) as error:
                print(json.dumps({"kind": "error", "message": str(error)}), flush=True)
                continue
            recorder.record(message)
            if message.get("kind") == "ping":
                emit_reply("pong")
                continue
            if message.get("kind") == "shutdown":
                break
    finally:
        recorder.close()
    return 0


def run_visual(recorder: EventRecorder, snapshot_path: Path | None = None) -> int:
    configure_qt_platform()
    try:
        from PySide6.QtCore import QAbstractNativeEventFilter, QObject, QPoint, QPointF, QRectF, Qt, QTimer, QUrl, Signal
        from PySide6.QtGui import (
            QColor, QDesktopServices, QFont, QFontMetrics, QMouseEvent, QPainter, QPainterPath, QPen, QPixmap, QPolygonF,
        )
        from PySide6.QtWidgets import QApplication, QMenu, QWidget
    except ImportError as error:
        print(
            f"PySide6 is required for visual mode ({error}). Run with --headless for protocol tests.",
            file=sys.stderr,
        )
        recorder.close()
        return 2

    class Inbox(QObject):
        message = Signal(dict)
        closed = Signal()

    # DAFEIYU_ASSET_ROOT points at another character (a codex-pets pack the
    # daemon prepared); sounds and cursors still come from the package.
    character_root = os.environ.get("DAFEIYU_ASSET_ROOT")
    manifest_path = (Path(character_root) if character_root else bundle_root() / "assets") / "pet-manifest.json"
    asset_root = manifest_path.parent / "pet"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"Unable to load BigFish asset manifest: {error}", file=sys.stderr)
        recorder.close()
        return 2

    class GloveCursorFilter(QAbstractNativeEventFilter):
        """Owns WM_SETCURSOR while the pointer is over the pet window.

        The pet shows a glove hand cursor: an open hand on hover and a closed
        fist while the left button is held. Native .cur cursors are loaded with
        LoadCursorFromFileW and handed to the OS cursor pipeline directly (the
        same rendering path as system cursors; note the API loads the resource
        at its natural 32x32 size and does not participate in DPI
        virtualization). The message is consumed immediately instead of going
        through Qt's QCursor bitmaps, which are re-scaled by Qt and only take
        effect on the next cursor update cycle.
        """

        def __init__(self, widget: Any, open_h: Any, closed_h: Any) -> None:
            super().__init__()
            self.widget = widget
            self.open_h = open_h
            self.closed_h = closed_h

        def nativeEventFilter(self, event_type: bytes, message: Any):
            try:
                if event_type != b"windows_generic_MSG":
                    return False, 0
                import ctypes
                from ctypes import wintypes

                msg = wintypes.MSG.from_address(int(message))
                if msg.message != 0x0020:  # WM_SETCURSOR
                    return False, 0
                hwnd = int(msg.hWnd) if msg.hWnd else 0
                if hwnd and hwnd != int(self.widget.winId()):
                    # Leave popups (context menu, …) to Qt's default cursor.
                    return False, 0
                hit_test = msg.lParam & 0xFFFF
                if hit_test != 1:  # HTCLIENT
                    return False, 0
                mouse_msg = (msg.lParam >> 16) & 0xFFFF
                handle = self.widget.glove.on_wm_setcursor(mouse_msg)
                if handle:
                    set_native_cursor(handle)
                    return True, 0
            except Exception:
                pass
            return False, 0

    class CompanionWindow(QWidget):
        LABELS = {
            "IDLE": "休息中",
            "THINKING": "思考中",
            "WORKING": "干活中",
            "WAITING": "等你呢",
            "SUCCESS": "完成啦",
            "ERROR": "出问题了",
            "DISCONNECTED": "已断开",
        }

        def __init__(self) -> None:
            super().__init__()
            self.layout_path = default_layout_path()
            self.layout = load_layout(self.layout_path)
            configured_scale = os.environ.get("DAFEIYU_SCALE")
            try:
                self.scale = min(1.4, max(0.55, float(configured_scale))) if configured_scale else self.layout["scale"]
            except ValueError:
                self.scale = self.layout["scale"]
            configured_bubble_scale = os.environ.get("DAFEIYU_BUBBLE_SCALE")
            try:
                self.bubble_scale = (
                    min(1.2, max(0.8, float(configured_bubble_scale)))
                    if configured_bubble_scale
                    else self.layout["bubbleScale"]
                )
            except ValueError:
                self.bubble_scale = self.layout["bubbleScale"]
            configured_reduced_motion = os.environ.get("DAFEIYU_REDUCED_MOTION")
            self.reduced_motion = (
                configured_reduced_motion == "1"
                if configured_reduced_motion is not None
                else self.layout["reducedMotion"]
            )
            configured_sound_enabled = os.environ.get("DAFEIYU_SOUND_ENABLED")
            self.sound_enabled = configured_sound_enabled != "0"
            self.activity_level = os.environ.get("DAFEIYU_ACTIVITY_LEVEL", "normal")
            configured_bubble_mode = os.environ.get("DAFEIYU_BUBBLE_MODE")
            self.bubble_mode = (
                configured_bubble_mode
                if configured_bubble_mode in {"auto", "always", "hidden", "custom"}
                else self.layout.get("bubbleMode", "auto")
            )
            configured_bubble_states = os.environ.get("DAFEIYU_BUBBLE_STATES")
            if configured_bubble_states is not None:
                self.bubble_states = [part.strip() for part in configured_bubble_states.split(",") if part.strip()]
            else:
                self.bubble_states = list(self.layout.get("bubbleStates", ["SUCCESS", "ERROR", "WAITING"]))
            self.model = Player(manifest)
            # Sprite-sheet characters name frames "cell:<column>:<row>:..." and
            # are cropped from one sheet; drawn at pixelScale times their size.
            sheet = manifest.get("spritesheet")
            self.pixel_scale = float(manifest.get("pixelScale", 1) or 1)
            self.bubble_headroom = float(manifest.get("bubbleHeadroom", HEADROOM_PX))
            self.sheet_pixmap: QPixmap | None = None
            self.sheet_cell = (int(sheet["cellWidth"]), int(sheet["cellHeight"])) if sheet else (0, 0)
            if sheet:
                self.sheet_pixmap = QPixmap()
                if not self.sheet_pixmap.loadFromData((asset_root / str(sheet["file"])).read_bytes(), "WEBP"):
                    raise RuntimeError("Unable to load the character sprite sheet")
            # Frame bytes are read from disk on demand and bounded; the full
            # whale set alone would keep ~236 MB resident.
            self.frame_sources: OrderedDict[str, bytes] = OrderedDict()
            self.frame_source_bytes = 0
            self.decoded_frames: OrderedDict[str, QPixmap] = OrderedDict()
            # Fail here, not on the first paint, when the starting frame is
            # unreadable or the bundled Qt has no WebP image plugin. Only this
            # one frame is read: decoding all 108 clips up front read the whole
            # asset set before the window even appeared.
            self._pixmap(self.model.frame)
            self.decoded_frames.clear()

            self.display_state = "IDLE"
            self.status_state = "IDLE"
            self.status_message = "我在这儿等新任务哦"
            self.status_detail = "DSH · 等待下一次任务"
            self.status_deadline_ms: int | None = self._now_ms() + 4200
            # Glove cursor: native .cur handles (loaded at natural size).
            self.glove_open_h = load_native_cursor(asset_root.parent / "cursor_grab.cur")
            self.glove_closed_h = load_native_cursor(asset_root.parent / "cursor_grabbing.cur")
            self.glove = GloveCursorController(self.glove_open_h, self.glove_closed_h)
            self.overlay_state: str | None = None
            self.overlay_message = ""
            self.overlay_detail = ""
            self.overlay_deadline_ms: int | None = None
            self.task = ""
            self.tasks: list[dict[str, Any]] = []
            self.webui_url = os.environ.get("DAFEIYU_WEBUI_URL", "http://127.0.0.1:3080/")
            self.open_label = os.environ.get("DAFEIYU_OPEN_LABEL", "打开 DSH")
            self.providers: list[tuple[str, str]] = []
            self.provider = ""
            self.whisper_level = ""
            self.characters: list[tuple[str, str]] = []
            self.character = ""
            self.balance_summary = ""
            self.drag_origin: QPoint | None = None
            self.pet_origin: QPoint | None = None
            self.pet_x = 0
            self.pet_y = 0
            self.dragging = False
            # The screen side the daemon docked the pet on, and where it comes
            # back out.
            self.dock_edge: str | None = None
            self.undocked_pet: tuple[int, int] | None = None
            # Lean while dragging, in degrees, easing toward tilt_target.
            self.tilt = 0.0
            self.tilt_target = 0.0
            self.drag_speed = 0.0
            self.last_drag_sample: tuple[int, float] | None = None
            self.last_tick_ms = self._now_ms()
            # Whether the last tick painted the bubble; a time-based status or
            # overlay expiry changes the visible card without a message.
            self.last_tick_bubble_visible = False
            self.fade_from_pixmap: QPixmap | None = None
            self.fade_started = 0.0
            self.fade_duration = 0.15
            self.animation_timer = QTimer(self)
            self.animation_timer.setTimerType(Qt.TimerType.PreciseTimer)
            self.animation_timer.timeout.connect(self._tick)
            self.animation_timer.start(self._animation_interval_ms())
            self.snapshot_saved = False
            self.setWindowTitle("大肥鱼")
            self.setWindowFlags(
                Qt.WindowType.FramelessWindowHint
                | Qt.WindowType.WindowStaysOnTopHint
                | Qt.WindowType.Tool
            )
            self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
            self._apply_window_size()
            QTimer.singleShot(0, self._restore_visible_position)

        def apply_message(self, message: dict[str, Any]) -> None:
            recorder.record(message)
            kind = message.get("kind")
            if kind == "shutdown":
                QApplication.quit()
                return
            previous_frame = self.model.frame
            previous_clip = self.model.active_clip_name
            if kind == "task":
                self.task = str(message.get("task", ""))
                self._show_status(
                    str(message.get("message", self.task)),
                    str(message.get("detail", "")),
                    self.status_state,
                    None if self.status_state in {"THINKING", "WORKING", "WAITING", "ERROR"} else 6000,
                )
            elif kind == "tasks":
                raw_tasks = message.get("tasks")
                self.tasks = raw_tasks if isinstance(raw_tasks, list) else []
                self._sync_bubble_size()
            elif kind == "config":
                self._apply_config(message)
            elif kind == "say":
                self._say(message)
            elif kind == "play":
                self._play(message)
            elif kind == "dock":
                self._set_dock(message.get("edge"))
            elif kind == "balance":
                self.balance_summary = str(message.get("summary", ""))[:200]
                self._sync_bubble_size()
            elif kind in {"state", "pulse"}:
                # Text and alerts only; the daemon sends the clip separately.
                state = str(message.get("state", "IDLE"))
                self.display_state = state
                if kind == "pulse":
                    ttl_ms = max(250, int(message.get("ttlMs", 1800)))
                    resume_state = str(message.get("resumeState", self.status_state))
                    self._show_status(
                        str(message.get("resumeMessage", self.LABELS.get(resume_state, resume_state))),
                        str(message.get("resumeDetail", "")),
                        resume_state,
                        None if resume_state in {"THINKING", "WORKING", "WAITING", "ERROR"} else ttl_ms + 2200,
                    )
                    self._show_overlay(
                        str(message.get("message", self.LABELS.get(state, state))),
                        str(message.get("detail", "")),
                        state,
                        ttl_ms,
                    )
                    if state in {"SUCCESS", "ERROR"}:
                        self._notify_alert(state)
                else:
                    self._clear_overlay()
                    persistent = state in {"THINKING", "WORKING", "WAITING", "ERROR"}
                    self._show_status(
                        str(message.get("message", self.LABELS.get(state, state))),
                        str(message.get("detail", "")),
                        state,
                        None if persistent else 4200,
                    )
            self._sync_frame_transition(previous_frame, previous_clip)
            self._sync_bubble_size()
            self.update()
            if snapshot_path is not None and not self.snapshot_saved:
                QTimer.singleShot(180, self._save_snapshot)

        def _set_reduced_motion(self, enabled: bool) -> None:
            self.reduced_motion = enabled
            self.animation_timer.setInterval(self._animation_interval_ms())

        def _apply_config(self, message: dict[str, Any]) -> None:
            """Apply a live CONFIG message without restarting the window."""
            if isinstance(message.get("openUrl"), str):
                self.webui_url = message["openUrl"]
            if isinstance(message.get("openLabel"), str):
                self.open_label = message["openLabel"]
            self.providers, self.provider = parse_providers(message, self.providers, self.provider)
            raw_characters = message.get("characters")
            if isinstance(raw_characters, list):
                self.characters = [
                    (str(item["id"]), str(item.get("name") or item["id"]))
                    for item in raw_characters
                    if isinstance(item, dict) and isinstance(item.get("id"), str)
                ]
            if isinstance(message.get("character"), str):
                self.character = message["character"]
            if message.get("whisperLevel") in {"off", "low", "high"}:
                self.whisper_level = message["whisperLevel"]
            scale = message.get("scale")
            if isinstance(scale, (int, float)) and not isinstance(scale, bool):
                self.scale = min(1.4, max(0.55, float(scale)))
            bubble_scale = message.get("bubbleScale")
            if isinstance(bubble_scale, (int, float)) and not isinstance(bubble_scale, bool):
                self.bubble_scale = min(1.2, max(0.8, float(bubble_scale)))
            reduced_motion = message.get("reducedMotion")
            if isinstance(reduced_motion, bool) and reduced_motion != self.reduced_motion:
                self._set_reduced_motion(reduced_motion)
            sound_enabled = message.get("soundEnabled")
            if isinstance(sound_enabled, bool):
                self.sound_enabled = sound_enabled
            activity_level = message.get("activityLevel")
            if activity_level in {"quiet", "normal", "lively"}:
                self.activity_level = activity_level
            bubble_mode = message.get("bubbleMode")
            if bubble_mode in {"auto", "always", "hidden", "custom"}:
                self.bubble_mode = bubble_mode
            bubble_states = message.get("bubbleStates")
            if isinstance(bubble_states, list):
                self.bubble_states = [str(state) for state in bubble_states if isinstance(state, str)]
            self._sync_bubble_size()
            self._save_layout()

        def _apply_glove(self, closed: bool) -> None:
            """Closed fist while the button is held, open hand otherwise.

            Sets the cursor directly so feedback is immediate instead of
            waiting for the next WM_SETCURSOR pass.
            """
            self.glove.pressed = closed
            handle = self.glove.handle_for(closed)
            if handle:
                set_native_cursor(handle)

        def enterEvent(self, event: Any) -> None:
            self._apply_glove(False)
            super().enterEvent(event)

        def leaveEvent(self, event: Any) -> None:
            self.glove.pressed = False
            reset_native_cursor()
            super().leaveEvent(event)

        def _animation_interval_ms(self) -> int:
            if self.reduced_motion:
                return 40
            # Sub-frame poll: a once-per-frame timer turns one early delivery into a whole-frame hitch.
            return max(8, min(20, round(self.model.active_clip.frame_ms / 3)))

        def _rearm_animation_interval(self) -> None:
            wanted = self._animation_interval_ms()
            if self.animation_timer.interval() != wanted:
                self.animation_timer.setInterval(wanted)

        def _frame_data(self, frame: str) -> bytes:
            """Compressed frame bytes, read on demand into a bounded FIFO cache.

            The read happens on the UI thread but is one ~17 KB file, which is
            cheaper than keeping the whole ~236 MB frame set resident.
            """
            cached = self.frame_sources.get(frame)
            if cached is not None:
                return cached
            try:
                data = (asset_root / frame).read_bytes()
            except OSError as error:
                raise RuntimeError(f"Unable to load BigFish frame: {frame}") from error
            self.frame_sources[frame] = data
            self.frame_source_bytes += len(data)
            while self.frame_source_bytes > COMPRESSED_FRAME_CACHE_BYTES and len(self.frame_sources) > 1:
                _, evicted = self.frame_sources.popitem(last=False)
                self.frame_source_bytes -= len(evicted)
            return data

        def _pixmap(self, frame: str) -> QPixmap:
            cached = self.decoded_frames.get(frame)
            if cached is not None:
                self.decoded_frames.move_to_end(frame)
                return cached
            if self.sheet_pixmap is not None:
                _, column, row = frame.split(":")[:3]
                width, height = self.sheet_cell
                pixmap = self.sheet_pixmap.copy(int(column) * width, int(row) * height, width, height)
            else:
                pixmap = QPixmap()
                image_format = "PNG" if frame.lower().endswith(".png") else "WEBP"
                if not pixmap.loadFromData(self._frame_data(frame), image_format):
                    raise RuntimeError(f"Unable to load BigFish frame: {frame}")
            self.decoded_frames[frame] = pixmap
            while len(self.decoded_frames) > DECODED_FRAME_CACHE:
                self.decoded_frames.popitem(last=False)
            return pixmap

        def _tick(self) -> None:
            now_ms = self._now_ms()
            previous_ms = self.last_tick_ms
            elapsed_ms = max(0, now_ms - self.last_tick_ms)
            self.last_tick_ms = now_ms
            previous_frame = self.model.frame
            previous_clip = self.model.active_clip_name
            previous_tilt = self.tilt
            was_bubble_visible = self.last_tick_bubble_visible
            # The daemon decides what follows each pass; report it. A docked
            # pet holds still.
            ended = None if self.dock_edge else self.model.advance(0 if self.reduced_motion else elapsed_ms)
            if ended is not None:
                emit_reply("pass", clip=ended)
            self._ease_tilt()
            self._sync_frame_transition(previous_frame, previous_clip)
            overlay_expired = False
            if self.overlay_deadline_ms is not None and now_ms >= self.overlay_deadline_ms:
                self._clear_overlay()
                overlay_expired = True
            # A status card can expire purely with time; message-driven repaints
            # cannot see that, so remember the tick it happens on.
            status_expired = (
                self.status_deadline_ms is not None
                and previous_ms < self.status_deadline_ms
                and now_ms >= self.status_deadline_ms
            )
            self._rearm_animation_interval()
            bubble_visible = self._bubble_visible()
            self.last_tick_bubble_visible = bubble_visible
            # Repaint only when something visible changed. A static (or docked,
            # or reduced-motion) pet must not be redrawn at the animation poll
            # rate, which used to run every 8-40 ms.
            if (
                self.model.frame != previous_frame
                or self.model.active_clip_name != previous_clip
                or self.tilt != previous_tilt
                or self.fade_from_pixmap is not None
                or overlay_expired
                or status_expired
                or bubble_visible != was_bubble_visible
            ):
                self.update()

        def _ease_tilt(self) -> None:
            if not self.dragging or self.reduced_motion:
                self.tilt_target = 0.0
            elif self.last_drag_sample is not None and time.monotonic() - self.last_drag_sample[1] > TILT_SETTLE_S:
                self.tilt_target = 0.0
                self.drag_speed = 0.0
            self.tilt += (self.tilt_target - self.tilt) * TILT_EASING
            if abs(self.tilt) < 0.05 and self.tilt_target == 0.0:
                self.tilt = 0.0

        def _sample_drag(self) -> None:
            now = time.monotonic()
            if self.last_drag_sample is not None and now > self.last_drag_sample[1]:
                speed = (self.pet_x - self.last_drag_sample[0]) / (now - self.last_drag_sample[1])
                self.drag_speed = self.drag_speed * 0.6 + speed * 0.4
                self.tilt_target = tilt_for_speed(self.drag_speed)
            self.last_drag_sample = (self.pet_x, now)

        def _screen_rect(self) -> tuple[int, int, int, int] | None:
            pet_width, pet_height = self._pet_size()
            geometry = self._screen_geometry_at(self.pet_x + pet_width // 2, self.pet_y + pet_height // 2)
            if geometry is None:
                return None
            return geometry.x(), geometry.y(), geometry.width(), geometry.height()

        def _screen_bounds(self) -> tuple[int, int, int, int] | None:
            """Physical display bounds, not the usable area left by bars/docks."""
            pet_width, pet_height = self._pet_size()
            screen = QApplication.screenAt(
                QPoint(self.pet_x + pet_width // 2, self.pet_y + pet_height // 2)
            ) or QApplication.primaryScreen()
            if screen is None:
                return None
            geometry = screen.geometry()
            return geometry.x(), geometry.y(), geometry.width(), geometry.height()

        def _screen_outer_edges(self) -> tuple[bool, bool]:
            """Which sides of the current screen are real display edges.

            A pet dropped against the seam between two displays must not dock:
            it would slide between them. Use physical screen geometry (not the
            available area) so insets from bars and docks do not hide a seam.
            """
            pet_width, pet_height = self._pet_size()
            screen = QApplication.screenAt(
                QPoint(self.pet_x + pet_width // 2, self.pet_y + pet_height // 2)
            ) or QApplication.primaryScreen()
            if screen is None:
                return True, True
            own = screen.geometry()
            screens = [
                (geometry.x(), geometry.y(), geometry.width(), geometry.height())
                for geometry in (candidate.geometry() for candidate in QApplication.screens())
            ]
            return screen_outer_edges((own.x(), own.y(), own.width(), own.height()), screens)

        def _set_dock(self, edge: Any) -> None:
            """Dock on a screen side, or come back out (None)."""
            edge = edge if edge in {"left", "right"} else None
            if edge == self.dock_edge:
                return
            screen = self._screen_rect()
            if edge is not None and screen is not None:
                left, top, width, height = screen
                pet_width, pet_height = self._pet_size()
                # Coming out, the pet stands fully on screen by the same side.
                out_x = left + 8 if edge == "left" else left + width - pet_width - 8
                self.undocked_pet = (out_x, min(max(self.pet_y, top), top + height - pet_height))
                self.dock_edge = edge
                self.fade_from_pixmap = None
                self._clear_overlay()
                self._sync_bubble_size()
                self._place_docked()
            elif self.dragging:
                # The daemon sends DOCK null as soon as a docked pet is
                # grabbed. Moving or resizing the window now would break the
                # grab offset under the pointer; _finish_drag restores the
                # normal window around the same anchor.
                self.dock_edge = None
                self.undocked_pet = None
            else:
                # A plain click still brings the pet back to the resting spot
                # it was docked from.
                self.dock_edge = None
                self._sync_bubble_size()
                if self.undocked_pet is not None:
                    self._move_to_pet(*self.undocked_pet)
                self.undocked_pet = None
            self._save_layout()
            self.update()

        def _place_docked(self) -> None:
            """Hold the docked pet half behind its screen side."""
            # The physical edge, so a visible Dock/taskbar does not leave the
            # pet floating beside it.
            screen = self._screen_bounds()
            if self.dock_edge is None or screen is None:
                return
            pet_width, pet_height = self._pet_size()
            self.pet_x = docked_x(self.dock_edge, (pet_width, pet_height), screen)
            # A quarter turn needs pet_width of vertical room; the docked window
            # grows to fit and the pet is vertically centred in it. Moving the
            # window up by that inset keeps the pet's screen centre unchanged.
            pet_bottom_inset = max(0, (self.height() - pet_height) // 2)
            self.move(self.pet_x - (self.width() - pet_width) // 2, self.pet_y - pet_bottom_inset)
            self.update()

        def _play(self, message: dict[str, Any]) -> None:
            """Switch to the clip the daemon chose."""
            clip = message.get("clip")
            if not isinstance(clip, str):
                return
            previous_frame, previous_clip = self.model.frame, self.model.active_clip_name
            loop = message.get("loop")
            # Reduced motion never advances frames, so a one-shot success/error
            # clip would freeze on its first frame; rest on the end pose.
            settle = self.reduced_motion
            if self.model.play(clip, loop if isinstance(loop, bool) else None, settle_last_frame=settle):
                allow_fade = not (self.dragging or clip.startswith("dragging"))
                self._sync_frame_transition(previous_frame, previous_clip, allow_fade=allow_fade)
                self.last_tick_ms = self._now_ms()

        def _say(self, message: dict[str, Any]) -> None:
            """Show a line; ordinary chatter waits for an idle pet."""
            text = str(message.get("message", "")).strip()[:80]
            if not text or self.dragging:
                return
            if message.get("urgent") is not True and self.status_state != "IDLE":
                return
            ttl_ms = max(1500, min(15000, int(message.get("ttlMs", 6000))))
            self._show_overlay(text, self.status_detail, self.status_state, ttl_ms)
            self._sync_bubble_size()
            self.update()

        def _play_action(self, clip_name: str, line: str) -> None:
            if not self.dragging:
                emit_reply("input", type="action", clip=clip_name, line=line)

        def _sync_frame_transition(
            self,
            previous_frame: str,
            previous_clip: str,
            *,
            allow_fade: bool = True,
        ) -> None:
            current_frame = self.model.frame
            if current_frame == previous_frame:
                return
            # Preserve an in-progress clip fade while its new video advances.
            if allow_fade and previous_clip == self.model.active_clip_name:
                return
            duration = crossfade_duration(previous_clip, self.model.active_clip_name) if allow_fade else None
            if duration is None:
                self.fade_from_pixmap = None
                return
            # The previous frame was on screen a moment ago, so its bytes are
            # either cached or one small disk read away.
            self.fade_from_pixmap = self._pixmap(previous_frame) if previous_frame else None
            self.fade_started = time.monotonic()
            self.fade_duration = duration

        def _begin_drag(self) -> None:
            if self.dragging:
                return
            self.dragging = True
            self.drag_speed = 0.0
            self.last_drag_sample = None
            emit_reply("input", type="drag-start")

        def _finish_drag(self) -> None:
            if not self.dragging:
                return
            self.dragging = False
            self.last_drag_sample = None
            # A pet dragged off a dock was living in the taller docked window;
            # restore the upright frame. The caller re-anchors the window right
            # after this, so the pet does not move on screen.
            old_size = (self.width(), self.height())
            self._apply_window_size()
            if (self.width(), self.height()) != old_size:
                self._move_to_pet(self.pet_x, self.pet_y)
            # Report a drop by a screen side; the daemon decides whether to dock.
            # Use physical bounds: a drop at the real edge should dock even when
            # a Dock insets the usable area.
            screen = self._screen_bounds()
            edge = (
                dock_edge((self.pet_x, self.pet_y, *self._pet_size()), screen, self._screen_outer_edges())
                if screen
                else None
            )
            if edge:
                emit_reply("input", type="drag-end", edge=edge)
            else:
                emit_reply("input", type="drag-end")

        def _bubble_visible(self) -> bool:
            if self.bubble_mode == "hidden" or self.dock_edge is not None:
                return False
            if self.bubble_mode == "always":
                return True
            if self.bubble_mode == "auto":
                # Working, or something to say; an idle pet keeps quiet.
                return len(self.tasks) >= 2 or self._current_card() is not None
            if len(self.tasks) >= 2:
                return any(task.get("state") in self.bubble_states for task in self.tasks)
            state = self.overlay_state or self.status_state or "IDLE"
            return state in self.bubble_states

        def _sync_bubble_size(self) -> None:
            if self.dragging:
                # Resizing now would shift the character inside the window and
                # break the grab offset; _finish_drag applies the new size.
                return
            old_size = (self.width(), self.height())
            self._apply_window_size()
            if (self.width(), self.height()) != old_size:
                self._move_to_pet(self.pet_x, self.pet_y)

        def _apply_window_size(self) -> None:
            pet_width = round(int(manifest["maxFrameWidth"]) * self._draw_scale())
            pet_height = round(int(manifest["maxFrameHeight"]) * self._draw_scale())
            # Clips with wide props are drawn centred on the pet; leave room
            # for the widest so it is never clipped by the window.
            max_clip_width = int(manifest.get("maxClipWidth", manifest["maxFrameWidth"]))
            pet_area = max(pet_width + 50, round(max_clip_width * self._draw_scale()) + 10)
            # Reserve room above and below the anchor for the 14-degree drag
            # lean. Keeping it constant means the grab offsets never change
            # mid-gesture.
            allowance = tilt_allowance((pet_width, pet_height))
            if self._bubble_visible():
                bubble_width = round(CARD_WIDTH * self.bubble_scale)
                bubble_height = self._card_height()
                self.setFixedSize(
                    max(pet_area, bubble_width + 28),
                    pet_height + bubble_height + 34 + allowance * 2,
                )
            else:
                height = pet_height + 26 + allowance * 2
                if self.dock_edge is not None:
                    # Turned a quarter, the pet spans its width vertically; a
                    # window reserved for the upright height would clip the
                    # docked head.
                    height = max(height, pet_width + 16)
                self.setFixedSize(pet_area, height)

        def _screen_geometry_at(self, x: int, y: int):
            screen = QApplication.screenAt(QPoint(x, y)) or QApplication.primaryScreen()
            if screen is None:
                return None
            return screen.availableGeometry()

        def _draw_scale(self) -> float:
            """User size times the character's pixel scale (2 for codex pets)."""
            return self.scale * self.pixel_scale

        def _pet_size(self) -> tuple[int, int]:
            return (
                round(int(manifest["maxFrameWidth"]) * self._draw_scale()),
                round(int(manifest["maxFrameHeight"]) * self._draw_scale()),
            )

        def _move_to_pet(self, pet_x: int, pet_y: int) -> None:
            """Resize or move the container around the character's anchor."""
            if self.dock_edge is not None:
                self._place_docked()
                return
            geometry = self._screen_geometry_at(pet_x, pet_y)
            screen = (geometry.x(), geometry.y(), geometry.width(), geometry.height()) if geometry is not None else None
            pet_size = self._pet_size()
            # position_window works with the upright layout height; the other
            # half of the tilt allowance becomes transparent room below the
            # anchor (the window top moves up by the other half).
            layout_height = max(1, self.height() - tilt_allowance(pet_size))
            window_x, window_y, self.pet_x, self.pet_y = position_window(
                (pet_x, pet_y), pet_size, (self.width(), layout_height), screen,
                self._card_height() if self._bubble_visible() else 0,
            )
            self.move(window_x, window_y)
            self.update()

        def _pet_offset_x(self, pet_width: int) -> int:
            return min(max(self.pet_x - self.x(), 0), self.width() - pet_width)

        def _pet_rect(self) -> tuple[int, int, int, int]:
            pet_width, pet_height = self._pet_size()
            offset_y = min(max(self.pet_y - self.y(), 0), self.height() - pet_height)
            return self._pet_offset_x(pet_width), offset_y, pet_width, pet_height

        def _bubble_rect(self) -> tuple[int, int, int, int]:
            card_width, card_height = self._bubble_size()
            pet_x, pet_y, pet_width, pet_height = self._pet_rect()
            margin = 14
            card_x = pet_x + pet_width // 2 - card_width // 2
            max_x = max(margin, self.width() - card_width - margin)
            card_x = min(max(card_x, margin), max_x)
            # Sit right above the head; flip below the pet near the screen top.
            tail = round(BUBBLE_TAIL[1] * self.bubble_scale)
            card_y = pet_y + round(self.bubble_headroom * self._draw_scale()) - tail - card_height
            self._bubble_below = card_y < 7
            if self._bubble_below:
                card_y = min(pet_y + pet_height + tail, max(7, self.height() - card_height - 7))
            return card_x, card_y, card_width, card_height

        def _primary_screen_height(self) -> int | None:
            """Primary display height, the flip reference for AppKit layouts."""
            screen = QApplication.primaryScreen()
            return screen.geometry().height() if screen is not None else None

        def _restore_visible_position(self) -> None:
            pet_width, pet_height = self._pet_size()
            top_offset = self.height() - pet_height - 8
            center_offset = (self.width() - pet_width) // 2
            screen_height = self._primary_screen_height()
            # Both helpers share the layout file; a native-macOS layout stores
            # AppKit bottom-left y and is converted using the display height.
            saved_pet = pet_position_from_layout(self.layout, pet_height, screen_height)
            if saved_pet is not None:
                pet_x, pet_y = saved_pet
            else:
                saved_x = self.layout.get("x")
                saved_y = self.layout.get("y")
                if isinstance(saved_x, int) and isinstance(saved_y, int):
                    # Legacy layouts stored the window position. Convert the
                    # window's y too when it came from the AppKit helper, then
                    # recreate the pet position the old centered layout had.
                    if self.layout.get("coordinateSpace") == "appkit-bottom-left" and screen_height is not None:
                        saved_y = appkit_to_qt_y(saved_y, self.height(), screen_height)
                    pet_x = saved_x + center_offset
                    pet_y = saved_y + top_offset
                else:
                    geometry = self._screen_geometry_at(self.x() + self.width() // 2, self.y() + self.height() // 2)
                    if geometry is None:
                        return
                    pet_x = geometry.right() - pet_width - 24
                    pet_y = geometry.bottom() - pet_height - 24
            self._move_to_pet(pet_x, pet_y)

        def _save_layout(self) -> None:
            self.layout = {
                "version": 1,
                "x": self.x(),
                "y": self.y(),
                # A docked pet is remembered where it comes back out.
                "petX": self.undocked_pet[0] if self.dock_edge and self.undocked_pet else self.pet_x,
                "petY": self.undocked_pet[1] if self.dock_edge and self.undocked_pet else self.pet_y,
                "scale": self.scale,
                "bubbleScale": self.bubble_scale,
                "reducedMotion": self.reduced_motion,
                "bubbleMode": self.bubble_mode,
                "bubbleStates": self.bubble_states,
                # This helper writes Qt top-left window coordinates. save_layout
                # re-asserts the marker; keeping it here documents the numbers.
                "coordinateSpace": "qt-top-left",
            }
            try:
                save_layout(self.layout_path, self.layout)
            except OSError as error:
                print(f"Unable to save BigFish layout: {error}", file=sys.stderr)

        def _save_snapshot(self) -> None:
            if snapshot_path is None or self.snapshot_saved:
                return
            snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            self.snapshot_saved = self.grab().save(str(snapshot_path), "PNG")

        def _show_status(self, message: str, detail: str, state: str, ttl_ms: int | None) -> None:
            self.status_message = message
            self.status_detail = detail
            self.status_state = state
            self.status_deadline_ms = None if ttl_ms is None else self._now_ms() + ttl_ms

        def _show_overlay(self, message: str, detail: str, state: str, ttl_ms: int) -> None:
            self.overlay_message = message
            self.overlay_detail = detail or self.status_detail
            self.overlay_state = state
            self.overlay_deadline_ms = self._now_ms() + ttl_ms

        def _clear_overlay(self) -> None:
            self.overlay_message = ""
            self.overlay_detail = ""
            self.overlay_state = None
            self.overlay_deadline_ms = None

        @staticmethod
        def _now_ms() -> int:
            return int(time.monotonic() * 1000)

        def _current_card(self) -> tuple[str, str, str] | None:
            now_ms = self._now_ms()
            if self.overlay_message and (
                self.overlay_deadline_ms is None or now_ms < self.overlay_deadline_ms
            ):
                return self.overlay_message, self.overlay_detail, self.overlay_state or self.status_state
            if self.status_message and (
                self.status_deadline_ms is None or now_ms < self.status_deadline_ms
            ):
                return self.status_message, self.status_detail, self.status_state
            if self.balance_summary and self.bubble_mode == "always":
                return "大肥鱼陪你待命", "", "IDLE"
            return None

        @staticmethod
        def _status_colors(state: str) -> tuple[QColor, QColor]:
            return {
                "SUCCESS": (QColor("#D9F7E4"), QColor("#12B85A")),
                "ERROR": (QColor("#FDE3E3"), QColor("#E5484D")),
                "WAITING": (QColor("#FFF0CE"), QColor("#D88A00")),
                "THINKING": (QColor("#E2ECFF"), QColor("#4C78E8")),
                "WORKING": (QColor("#DDEBFF"), QColor("#3478F6")),
                "DISCONNECTED": (QColor("#ECEEF1"), QColor("#7B818A")),
            }.get(state, (QColor("#ECEEF1"), QColor("#747A84")))

        def _bubble_font(self, point_size: float, bold: bool) -> QFont:
            font = QFont()
            font.setFamilies(BUBBLE_FONT_FAMILIES)
            font.setPointSizeF(point_size * min(1.2, max(1.0, self.bubble_scale)))
            font.setWeight(QFont.Weight.Bold if bold else QFont.Weight.Medium)
            return font

        def _footer_height(self) -> int:
            return round(20 * self.bubble_scale) if self.balance_summary else 0

        def _task_rows(self) -> int:
            return min(len(self.tasks), 3) + (1 if len(self.tasks) > 3 else 0)

        def _card_height(self) -> int:
            """Window room reserved for the bubble: its tallest size plus the tail."""
            s = self.bubble_scale
            if len(self.tasks) >= 2:
                return round((40 + self._task_rows() * 22 + BUBBLE_TAIL[1]) * s) + self._footer_height()
            return round((64 + BUBBLE_TAIL[1]) * s) + self._footer_height()

        def _bubble_size(self) -> tuple[int, int]:
            s = self.bubble_scale
            if len(self.tasks) >= 2:
                return round(CARD_WIDTH * s), round((40 + self._task_rows() * 22) * s) + self._footer_height()
            card = self._current_card()
            if card is None:
                return 0, 0
            title, detail, _ = card
            widest = QFontMetrics(self._bubble_font(14, True)).horizontalAdvance(title)
            if detail:
                widest = max(widest, QFontMetrics(self._bubble_font(10, False)).horizontalAdvance(detail))
            if self.balance_summary:
                widest = max(widest, QFontMetrics(self._bubble_font(9, False)).horizontalAdvance(self.balance_summary))
            width = min(round(CARD_WIDTH * s), max(round(110 * s), widest + round(40 * s)))
            height = round((60 if detail else 44) * s) + self._footer_height()
            return width, height

        def _draw_bubble_shape(self, painter: QPainter, x: int, y: int, width: int, height: int, below: bool) -> None:
            """White rounded bubble with a tail pointing at the pet's head."""
            s = self.bubble_scale
            radius = min(round(18 * s), height // 2)
            tail_width, tail_height = round(BUBBLE_TAIL[0] * s), round(BUBBLE_TAIL[1] * s)
            pet_x, _, pet_width, _ = self._pet_rect()
            tail_x = min(max(pet_x + pet_width // 2, x + radius + tail_width // 2), x + width - radius - tail_width // 2)
            path = QPainterPath()
            path.addRoundedRect(QRectF(x, y, width, height), radius, radius)
            base_y, tip_y = (y + 1, y - tail_height) if below else (y + height - 1, y + height + tail_height)
            path.addPolygon(QPolygonF([
                QPointF(tail_x - tail_width / 2, base_y), QPointF(tail_x, tip_y), QPointF(tail_x + tail_width / 2, base_y),
            ]))
            path.setFillRule(Qt.FillRule.WindingFill)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(*BUBBLE_SHADOW))
            painter.drawPath(path.translated(0, round(2 * s)))
            painter.setBrush(QColor(*BUBBLE_FILL))
            painter.drawPath(path)

        def _draw_multi_task_card(
            self,
            painter: QPainter,
            card_x: int,
            card_y: int,
            card_width: int,
            card_height: int,
            s: float,
        ) -> None:
            title_font = self._bubble_font(14, True)
            detail_font = self._bubble_font(10, False)
            text_x = card_x + round(16 * s)
            text_width = max(40, card_width - round(32 * s))
            painter.setFont(title_font)
            painter.setPen(QColor(BUBBLE_TEXT))
            title = f"{len(self.tasks)} 个任务进行中"
            painter.drawText(
                text_x,
                card_y + round(12 * s),
                text_width,
                max(12, round(20 * s)),
                Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                QFontMetrics(title_font).elidedText(title, Qt.TextElideMode.ElideRight, text_width),
            )
            painter.setFont(detail_font)
            for index, task in enumerate(self.tasks[:3]):
                row_y = card_y + round((38 + index * 22) * s)
                state = str(task.get("state", "IDLE"))
                state_label = self.LABELS.get(state, state)
                label = task.get("project") or task.get("task") or task.get("message") or state_label
                line = f"{state_label} · {label}"
                _, foreground = self._status_colors(state)
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(foreground)
                painter.drawEllipse(text_x, row_y + round(4 * s), round(8 * s), round(8 * s))
                painter.setPen(QColor(BUBBLE_SUBTEXT))
                painter.drawText(
                    text_x + round(14 * s),
                    row_y,
                    text_width - round(14 * s),
                    max(12, round(20 * s)),
                    Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                    QFontMetrics(detail_font).elidedText(line, Qt.TextElideMode.ElideRight, text_width - round(14 * s)),
                )
            if len(self.tasks) > 3:
                more = f"还有 {len(self.tasks) - 3} 个任务…"
                painter.setPen(QColor(BUBBLE_SUBTEXT))
                painter.drawText(
                    text_x + round(14 * s),
                    card_y + round((38 + 3 * 22) * s),
                    text_width,
                    max(12, round(20 * s)),
                    Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                    more,
                )

        def _notify_alert(self, state: str) -> None:
            if self.sound_enabled:
                played = False
                if sys.platform == "win32":
                    try:
                        import winsound

                        sound_name = "success.wav" if state == "SUCCESS" else "error.wav"
                        sound_path = bundle_root() / "assets" / "sounds" / sound_name
                        winsound.PlaySound(
                            str(sound_path),
                            winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT,
                        )
                        played = True
                    except (ImportError, OSError, RuntimeError):
                        pass
                if not played:
                    try:
                        QApplication.beep()
                    except Exception:
                        pass

        def paintEvent(self, _event: Any) -> None:
            painter = QPainter(self)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
            # 平滑缩放：放大/缩小时插值，避免锯齿和模糊
            painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
            card = self._current_card() if self._bubble_visible() else None
            card_x, card_y, card_width, card_height = self._bubble_rect()
            s = self.bubble_scale

            below = getattr(self, "_bubble_below", False)
            if len(self.tasks) >= 2 and self._bubble_visible():
                self._draw_bubble_shape(painter, card_x, card_y, card_width, card_height, below)
                self._draw_multi_task_card(painter, card_x, card_y, card_width, card_height, s)
            elif card:
                title, detail, _ = card
                self._draw_bubble_shape(painter, card_x, card_y, card_width, card_height, below)
                text_x = card_x + round(16 * s)
                text_width = max(40, card_width - round(32 * s))
                centred = Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignVCenter
                title_font = self._bubble_font(14, True)
                painter.setFont(title_font)
                painter.setPen(QColor(BUBBLE_TEXT))
                painter.drawText(
                    text_x, card_y + round(12 * s), text_width, round(20 * s), centred,
                    QFontMetrics(title_font).elidedText(title, Qt.TextElideMode.ElideRight, text_width),
                )
                if detail:
                    detail_font = self._bubble_font(10, False)
                    painter.setFont(detail_font)
                    painter.setPen(QColor(BUBBLE_SUBTEXT))
                    painter.drawText(
                        text_x, card_y + round(36 * s), text_width, round(16 * s), centred,
                        QFontMetrics(detail_font).elidedText(detail, Qt.TextElideMode.ElideRight, text_width),
                    )

            if self.balance_summary and self._bubble_visible() and card_width:
                balance_font = self._bubble_font(9, False)
                painter.setFont(balance_font)
                painter.setPen(QColor(BUBBLE_SUBTEXT))
                text_width = card_width - round(32 * s)
                footer = self._footer_height()
                text = QFontMetrics(balance_font).elidedText(self.balance_summary, Qt.TextElideMode.ElideRight, text_width)
                painter.drawText(card_x + round(16 * s), card_y + card_height - footer - round(2 * s),
                                 text_width, footer, Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignVCenter, text)

            pixmap = self._pixmap(self.model.frame)

            fade_alpha = 1.0
            if self.fade_from_pixmap is not None and not self.fade_from_pixmap.isNull():
                fade_elapsed = time.monotonic() - self.fade_started
                if fade_elapsed < self.fade_duration:
                    fade_alpha = min(1.0, (fade_elapsed / self.fade_duration) ** 0.7)
                else:
                    self.fade_from_pixmap = None

            def draw_pet(pix: QPixmap, alpha: float) -> None:
                pw = pix.width() * self._draw_scale()
                ph = pix.height() * self.scale * self.pixel_scale
                x, y, pet_width, _ = self._pet_rect()
                # Wide clips keep the pet's scale and centre; only their width differs.
                x += (pet_width - pw) / 2
                painter.save()
                angle = dock_angle(self.dock_edge) + self.tilt
                if angle:
                    # Turn about the pet's centre; Qt's y axis points down,
                    # so a positive angle turns clockwise.
                    _, pet_y, _, pet_height = self._pet_rect()
                    center_x, center_y = x + pw / 2, pet_y + pet_height / 2
                    painter.translate(center_x, center_y)
                    painter.rotate(angle)
                    painter.translate(-center_x, -center_y)
                painter.setOpacity(alpha)
                painter.drawPixmap(QRectF(x, y, pw, ph), pix, QRectF(0, 0, pix.width(), pix.height()))
                painter.restore()

            if fade_alpha < 1.0 and self.fade_from_pixmap is not None:
                # Keep the old frame opaque underneath so the pet never flashes transparent.
                draw_pet(self.fade_from_pixmap, 1.0)
            draw_pet(pixmap, fade_alpha)

        def mousePressEvent(self, event: QMouseEvent) -> None:
            if event.button() == Qt.MouseButton.LeftButton:
                self._apply_glove(True)
                self.drag_origin = event.globalPosition().toPoint()
                self.pet_origin = QPoint(self.pet_x, self.pet_y)
                self.dragging = False

        def mouseMoveEvent(self, event: QMouseEvent) -> None:
            if self.drag_origin is not None and self.pet_origin is not None:
                if not self.dragging and (event.globalPosition().toPoint() - self.drag_origin).manhattanLength() > 5:
                    self._begin_drag()
                delta = event.globalPosition().toPoint() - self.drag_origin
                self._move_to_pet(self.pet_origin.x() + delta.x(), self.pet_origin.y() + delta.y())
                if self.dragging:
                    self._sample_drag()

        def mouseReleaseEvent(self, event: QMouseEvent) -> None:
            if event.button() == Qt.MouseButton.LeftButton:
                if self.dragging:
                    self._finish_drag()
                    self._move_to_pet(self.pet_x, self.pet_y)
                    self._save_layout()
                else:
                    self._play_click_interaction(event.position().x(), event.position().y())
            self.drag_origin = None
            self.pet_origin = None
            self.dragging = False
            # The button state is authoritative: restore the open hand if the
            # pointer is still over the pet, or the default arrow otherwise.
            self.glove.pressed = False
            if self.rect().contains(event.position().toPoint()):
                self._apply_glove(False)
            else:
                reset_native_cursor()

        def _play_click_interaction(self, x: float, y: float) -> None:
            """Report which part of the pet was clicked; the daemon reacts."""
            pet_x, pet_y, pet_width, pet_height = self._pet_rect()
            relative_x = max(0.0, x - pet_x)
            relative_y = max(0.0, y - pet_y)
            if relative_y < pet_height * 0.45:
                region = "head_pat"
            elif relative_x > pet_width * 0.72:
                region = "tail"
            else:
                region = "poke"
            emit_reply("input", type="click", region=region)

        def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:
            if event.button() == Qt.MouseButton.LeftButton:
                emit_reply("input", type="double-click")

        def contextMenuEvent(self, event: Any) -> None:
            menu = QMenu(self)
            size_menu = menu.addMenu("大小")
            size_actions = {}
            for label, scale in (("小", 0.6), ("中", 0.8), ("大", 1.0), ("特大", 1.25)):
                action = size_menu.addAction(label)
                action.setCheckable(True)
                action.setChecked(abs(self.scale - scale) < 0.05)
                size_actions[action] = scale
            bubble_size_menu = menu.addMenu("气泡大小")
            bubble_size_actions = {}
            for label, bubble_scale in (("小", 0.8), ("标准", 1.0), ("大", 1.2)):
                action = bubble_size_menu.addAction(label)
                action.setCheckable(True)
                action.setChecked(abs(self.bubble_scale - bubble_scale) < 0.05)
                bubble_size_actions[action] = bubble_scale
            provider_actions = {}
            if len(self.providers) > 1:
                provider_menu = menu.addMenu("服务商")
                for provider_id, label in self.providers:
                    action = provider_menu.addAction(label)
                    action.setCheckable(True)
                    action.setChecked(provider_id == self.provider)
                    provider_actions[action] = provider_id
            action_menu = menu.addMenu("动作")
            action_items = {}
            for group_label, entries in action_menu_groups(manifest):
                group = action_menu.addMenu(group_label) if group_label else action_menu
                for label, clip, line in entries:
                    if clip in self.model.clips:
                        action_items[group.addAction(label)] = (clip, line)
            character_actions = {}
            if len(self.characters) > 1:
                character_menu = menu.addMenu("形象")
                for character_id, label in self.characters:
                    action = character_menu.addAction(label)
                    action.setCheckable(True)
                    action.setChecked(character_id == self.character)
                    character_actions[action] = character_id
            say_action = menu.addAction("说句话")
            whisper_menu = menu.addMenu("碎碎念")
            whisper_actions = {}
            for label, level in WHISPER_MENU:
                action = whisper_menu.addAction(label)
                action.setCheckable(True)
                action.setChecked(level == self.whisper_level)
                whisper_actions[action] = level
            # Only the shared daemon answers these requests.
            say_action.setVisible(bool(self.whisper_level))
            whisper_menu.menuAction().setVisible(bool(self.whisper_level))
            reduced_action = menu.addAction("减少动态")
            reduced_action.setCheckable(True)
            reduced_action.setChecked(self.reduced_motion)
            open_webui_action = menu.addAction(self.open_label) if self.webui_url and self.open_label else None
            settings_action = menu.addAction("设置…") if self.whisper_level else None
            menu.addSeparator()
            hide_action = menu.addAction("本次隐藏")
            exit_action = menu.addAction("本次关闭")
            selected = menu.exec(event.globalPos())
            if selected in size_actions:
                self.scale = size_actions[selected]
                self._apply_window_size()
                self._move_to_pet(self.pet_x, self.pet_y)
                self._save_layout()
                emit_reply("settings", scale=self.scale)
            elif selected in bubble_size_actions:
                self.bubble_scale = bubble_size_actions[selected]
                self._apply_window_size()
                self._move_to_pet(self.pet_x, self.pet_y)
                self._save_layout()
                emit_reply("settings", bubbleScale=self.bubble_scale)
            elif selected in action_items:
                self._play_action(*action_items[selected])
            elif settings_action is not None and selected == settings_action:
                emit_reply("settings", request="settings")
            elif selected == say_action:
                emit_reply("settings", request="whisper")
            elif selected in whisper_actions:
                self.whisper_level = whisper_actions[selected]
                emit_reply("settings", whisperLevel=self.whisper_level)
            elif selected in character_actions:
                emit_reply("settings", character=character_actions[selected])
            elif selected in provider_actions:
                self.provider = provider_actions[selected]
                emit_reply("settings", provider=self.provider)
            elif selected == reduced_action:
                self._set_reduced_motion(reduced_action.isChecked())
                self._save_layout()
                emit_reply("settings", reducedMotion=self.reduced_motion)
                self.update()
            elif open_webui_action is not None and selected == open_webui_action:
                self._open_client()
            elif selected == hide_action:
                self.hide()
            elif selected == exit_action:
                self._save_layout()
                emit_reply("closed", reason="user")
                QApplication.quit()

        def _open_client(self) -> None:
            if not QDesktopServices.openUrl(QUrl(self.webui_url)):
                print("Unable to open the configured DSH client", file=sys.stderr)
                self._show_overlay("无法打开 DSH", "请确认 DSH 已安装、打开地址设置正确", "ERROR", 4000)
                self._sync_bubble_size()
                self.update()

    application = QApplication(sys.argv[:1])
    application.setQuitOnLastWindowClosed(False)
    inbox = Inbox()
    window = CompanionWindow()
    glove_filter = GloveCursorFilter(window, window.glove_open_h, window.glove_closed_h)
    application.installNativeEventFilter(glove_filter)
    inbox.message.connect(window.apply_message)
    inbox.closed.connect(application.quit)

    def read_stdin() -> None:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                message = parse_message(line)
                if message.get("kind") == "ping":
                    emit_reply("pong")
                inbox.message.emit(message)
            except (ValueError, json.JSONDecodeError) as error:
                print(json.dumps({"kind": "error", "message": str(error)}), flush=True)
        inbox.closed.emit()

    reader = threading.Thread(target=read_stdin, name="dsh-bigfish-stdin", daemon=True)
    reader.start()
    window.show()
    emit_reply("ready")
    code = application.exec()
    recorder.close()
    return code


def main() -> int:
    configure_stdio()
    parser = argparse.ArgumentParser(description="DSH BigFish native helper")
    parser.add_argument("--headless", action="store_true", help="validate the protocol without opening a window")
    parser.add_argument("--event-log", type=Path, help="append received protocol messages to a JSONL file")
    parser.add_argument("--snapshot", type=Path, help="save one diagnostic visual frame after the first message")
    args = parser.parse_args()
    recorder = EventRecorder(args.event_log)
    return run_headless(recorder) if args.headless else run_visual(recorder, args.snapshot)


if __name__ == "__main__":
    raise SystemExit(main())
