"""Small, DSH-owned persistence layer for companion window layout."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


DEFAULT_LAYOUT: dict[str, Any] = {
    "version": 1,
    "x": None,
    "y": None,
    "petX": None,
    "petY": None,
    "scale": 1.0,
    "bubbleScale": 1.0,
    "reducedMotion": False,
    "bubbleMode": "auto",
    "bubbleStates": ["SUCCESS", "ERROR", "WAITING"],
    # This helper's window coordinates have a top-left origin (Qt). The native
    # macOS helper stores AppKit bottom-left coordinates and marks its files
    # accordingly; legacy files written before the marker existed were Qt's.
    "coordinateSpace": "qt-top-left",
}

QT_COORDINATE_SPACE = "qt-top-left"
APPKIT_COORDINATE_SPACE = "appkit-bottom-left"


def appkit_to_qt_y(y: int, height: int, screen_height: int) -> int:
    """Convert an AppKit bottom-left global y to Qt's top-left global y.

    Both helpers share one layout file, so a native-macOS layout read by this
    helper must be flipped by the primary display height. The conversion is its
    own inverse: AppKit's y axis grows up from the primary screen's bottom.
    """
    return screen_height - y - height


def pet_position_from_layout(
    layout: dict[str, Any],
    pet_height: int,
    screen_height: int | None,
) -> tuple[int, int] | None:
    """The pet anchor in Qt top-left coordinates, or None when not stored.

    An AppKit layout is converted when `screen_height` is known; without it the
    stored numbers are kept as-is (the caller can only do so much on a headless
    or screenless run) — see the note in the helper.
    """
    pet_x = layout.get("petX")
    pet_y = layout.get("petY")
    if not (
        isinstance(pet_x, int)
        and not isinstance(pet_x, bool)
        and isinstance(pet_y, int)
        and not isinstance(pet_y, bool)
    ):
        return None
    if layout.get("coordinateSpace") == APPKIT_COORDINATE_SPACE and screen_height is not None:
        pet_y = appkit_to_qt_y(pet_y, pet_height, screen_height)
    return pet_x, pet_y


def default_layout_path() -> Path:
    override = os.environ.get("DAFEIYU_LAYOUT_PATH")
    if override:
        return Path(override)
    # Same home as the pet daemon's settings (src/daemon-store.js).
    home = os.environ.get("DAFEIYU_HOME")
    if home:
        return Path(home) / "layout.json"
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "dafeiyu" / "layout.json"
    return Path.home() / ".dafeiyu" / "layout.json"


def normalise_layout(value: Any) -> dict[str, Any]:
    layout = dict(DEFAULT_LAYOUT)
    if not isinstance(value, dict):
        return layout
    for key in ("x", "y", "petX", "petY"):
        coordinate = value.get(key)
        if isinstance(coordinate, int) and not isinstance(coordinate, bool):
            layout[key] = coordinate
    scale = value.get("scale")
    if isinstance(scale, (int, float)) and not isinstance(scale, bool):
        layout["scale"] = min(1.4, max(0.55, float(scale)))
    bubble_scale = value.get("bubbleScale")
    if isinstance(bubble_scale, (int, float)) and not isinstance(bubble_scale, bool):
        layout["bubbleScale"] = min(1.2, max(0.8, float(bubble_scale)))
    if isinstance(value.get("reducedMotion"), bool):
        layout["reducedMotion"] = value["reducedMotion"]
    if value.get("bubbleMode") in {"auto", "always", "hidden", "custom"}:
        layout["bubbleMode"] = value["bubbleMode"]
    if isinstance(value.get("bubbleStates"), list):
        layout["bubbleStates"] = [str(state) for state in value["bubbleStates"] if isinstance(state, str)]
    if value.get("coordinateSpace") in {QT_COORDINATE_SPACE, APPKIT_COORDINATE_SPACE}:
        layout["coordinateSpace"] = value["coordinateSpace"]
    return layout


def load_layout(path: Path) -> dict[str, Any]:
    try:
        return normalise_layout(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return dict(DEFAULT_LAYOUT)


def save_layout(path: Path, value: dict[str, Any]) -> None:
    layout = normalise_layout(value)
    # This helper always writes Qt top-left coordinates, even when it just read
    # a native-macOS layout and translated it; the marker must say what the
    # numbers on disk actually mean.
    layout["coordinateSpace"] = QT_COORDINATE_SPACE
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(layout, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            Path(temporary_name).unlink()
        except FileNotFoundError:
            pass
