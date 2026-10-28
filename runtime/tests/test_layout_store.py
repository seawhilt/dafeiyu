import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from runtime.layout_store import (
    APPKIT_COORDINATE_SPACE,
    DEFAULT_LAYOUT,
    QT_COORDINATE_SPACE,
    appkit_to_qt_y,
    default_layout_path,
    load_layout,
    normalise_layout,
    pet_position_from_layout,
    save_layout,
)


class LayoutStoreTests(unittest.TestCase):
    def test_corrupt_layout_falls_back_safely(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layout.json"
            path.write_text("not json", encoding="utf-8")
            self.assertEqual(load_layout(path), DEFAULT_LAYOUT)

    def test_layout_is_clamped_and_saved_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "layout.json"
            save_layout(path, {"x": 120, "y": -20, "scale": 5, "reducedMotion": True})
            self.assertEqual(load_layout(path), {
                "version": 1,
                "x": 120,
                "y": -20,
                "petX": None,
                "petY": None,
                "scale": 1.4,
                "bubbleScale": 1.0,
                "reducedMotion": True,
                "bubbleMode": "auto",
                "bubbleStates": ["SUCCESS", "ERROR", "WAITING"],
                "coordinateSpace": "qt-top-left",
            })
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["scale"], 1.4)
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_boolean_is_not_accepted_as_a_coordinate_or_scale(self) -> None:
        self.assertEqual(normalise_layout({"x": True, "petX": False, "scale": False, "bubbleScale": False}), DEFAULT_LAYOUT)

    def test_bubble_mode_and_states_are_normalised(self) -> None:
        self.assertEqual(normalise_layout({"bubbleMode": "hidden"})["bubbleMode"], "hidden")
        self.assertEqual(normalise_layout({"bubbleMode": "invalid"})["bubbleMode"], "auto")
        self.assertEqual(normalise_layout({"bubbleMode": "always"})["bubbleMode"], "always")
        self.assertEqual(normalise_layout({"bubbleStates": ["SUCCESS", "ERROR"]})["bubbleStates"], ["SUCCESS", "ERROR"])
        self.assertEqual(normalise_layout({"bubbleStates": "bad"})["bubbleStates"], ["SUCCESS", "ERROR", "WAITING"])

    def test_bubble_scale_is_clamped(self) -> None:
        self.assertEqual(normalise_layout({"bubbleScale": 9})["bubbleScale"], 1.2)
        self.assertEqual(normalise_layout({"bubbleScale": 0.1})["bubbleScale"], 0.8)
        self.assertEqual(normalise_layout({})["bubbleScale"], 1.0)

    def test_layout_lives_in_the_dafeiyu_home(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"DAFEIYU_HOME": directory, "LOCALAPPDATA": "/tmp/local"}, clear=True):
                self.assertEqual(default_layout_path(), Path(directory) / "layout.json")
            with patch.dict(os.environ, {"LOCALAPPDATA": directory}, clear=True):
                self.assertEqual(default_layout_path(), Path(directory) / "dafeiyu" / "layout.json")
            # Path.home() needs HOME/USERPROFILE, so pin it instead of clearing
            # the whole environment (Windows cannot resolve home without it).
            with patch.dict(os.environ, {}, clear=True), patch("runtime.layout_store.Path.home", return_value=Path(directory)):
                self.assertEqual(default_layout_path(), Path(directory) / ".dafeiyu" / "layout.json")

    def test_character_scale_supports_the_mini_range(self) -> None:
        self.assertEqual(normalise_layout({"scale": 0.1})["scale"], 0.55)
        self.assertEqual(normalise_layout({"scale": 0.6})["scale"], 0.6)

    def test_saved_layout_is_marked_as_qt_top_left(self) -> None:
        # This helper must never write AppKit numbers under the Qt marker.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layout.json"
            save_layout(path, {"petX": 100, "petY": 200, "coordinateSpace": APPKIT_COORDINATE_SPACE})
            on_disk = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(on_disk["coordinateSpace"], QT_COORDINATE_SPACE)
            self.assertEqual(load_layout(path)["coordinateSpace"], QT_COORDINATE_SPACE)

    def test_legacy_layout_without_marker_reads_as_qt(self) -> None:
        self.assertEqual(DEFAULT_LAYOUT["coordinateSpace"], QT_COORDINATE_SPACE)
        self.assertEqual(normalise_layout({})["coordinateSpace"], QT_COORDINATE_SPACE)
        # An unknown marker (a foreign future helper) falls back to Qt too.
        self.assertEqual(normalise_layout({"coordinateSpace": "screen-space"})["coordinateSpace"], QT_COORDINATE_SPACE)

    def test_appkit_layout_y_is_flipped_by_the_screen_height(self) -> None:
        screen_height, pet_height = 982, 344
        layout = normalise_layout({"petX": 100, "petY": 200, "coordinateSpace": APPKIT_COORDINATE_SPACE})
        self.assertEqual(
            pet_position_from_layout(layout, pet_height, screen_height),
            (100, screen_height - 200 - pet_height),
        )
        # The stored numbers mean bottom-left y; the conversion is its inverse.
        appkit_y = screen_height - 200 - pet_height
        self.assertEqual(appkit_to_qt_y(appkit_to_qt_y(appkit_y, pet_height, screen_height), pet_height, screen_height), appkit_y)

    def test_qt_layout_is_read_as_is(self) -> None:
        layout = normalise_layout({"petX": 100, "petY": 200, "coordinateSpace": QT_COORDINATE_SPACE})
        self.assertEqual(pet_position_from_layout(layout, 344, 982), (100, 200))
        # A legacy (unmarked) layout from this helper is already top-left.
        self.assertEqual(pet_position_from_layout({"petX": 100, "petY": 200}, 344, 982), (100, 200))

    def test_appkit_layout_without_a_screen_height_keeps_its_numbers(self) -> None:
        layout = normalise_layout({"petX": 100, "petY": 200, "coordinateSpace": APPKIT_COORDINATE_SPACE})
        self.assertEqual(pet_position_from_layout(layout, 344, None), (100, 200))
        self.assertIsNone(pet_position_from_layout(normalise_layout({}), 344, 982))


if __name__ == "__main__":
    unittest.main()
