import unittest

from runtime.pet_geometry import (
    DOCK_PEEK,
    MAX_TILT,
    bubble_top,
    dock_angle,
    dock_edge,
    docked_x,
    position_window,
    tilt_for_speed,
)


class PetGeometryTests(unittest.TestCase):
    def test_card_changes_preserve_positions_at_every_screen_edge(self) -> None:
        for screen in ((0, 0, 1920, 1040), (-1920, -200, 1920, 1040)):
            left, top, width, height = screen
            for pet in ((left, top), (left + 80, top + 30), (left + width - 412, top + height - 344)):
                for card_height in (0, 84, 112, 164, 197):
                    window_size = (462, 370) if not card_height else (532, 344 + card_height + 34)
                    wx, wy, px, py = position_window(pet, (412, 344), window_size, screen, card_height)
                    self.assertEqual((px, py), pet)
                    self.assertGreaterEqual(wx, left)
                    self.assertGreaterEqual(wy, top)
                    self.assertLessEqual(wx + window_size[0], left + width)
                    self.assertLessEqual(wy + window_size[1], top + height)
                    self.assertGreaterEqual(px - wx, 0)
                    self.assertGreaterEqual(py - wy, 0)
                    self.assertLessEqual(px - wx + 412, window_size[0])
                    self.assertLessEqual(py - wy + 344, window_size[1])
                    if card_height:
                        cy = bubble_top(py - wy, 344, card_height, window_size[1])
                        self.assertTrue(cy + card_height <= py - wy or cy >= py - wy + 344)

    def test_card_goes_below_a_pet_near_the_top(self) -> None:
        wx, wy, px, py = position_window((200, 30), (412, 344), (462, 490), (0, 0, 1920, 1040), 112)
        cy = bubble_top(py - wy, 344, 112, 490)
        self.assertGreater(cy, py - wy + 344)

    def test_tiny_screens_and_missing_screen_do_not_move_a_valid_anchor(self) -> None:
        self.assertEqual(position_window((20, 10), (200, 180), (460, 500), (0, 0, 320, 240), 286)[2:], (20, 10))
        self.assertEqual(position_window((-100, -20), (412, 344), (462, 370), None)[2:], (-100, -20))

    def test_offscreen_positions_are_clamped_to_the_character(self) -> None:
        for pet, expected in (((-9999, -9999), (0, 0)), ((9999, 9999), (1508, 696))):
            self.assertEqual(position_window(pet, (412, 344), (462, 490), (0, 0, 1920, 1040), 112)[2:], expected)


if __name__ == '__main__':
    unittest.main()


class DockGeometryTests(unittest.TestCase):
    SCREEN = (0, 0, 1000, 800)

    def test_a_drop_by_a_side_of_the_screen_docks_there(self) -> None:
        self.assertEqual(dock_edge((0, 100, 200, 220), self.SCREEN), "left")
        self.assertEqual(dock_edge((790, 100, 200, 220), self.SCREEN), "right")
        self.assertIsNone(dock_edge((400, 100, 200, 220), self.SCREEN))

    def test_a_docked_pet_shows_only_its_head(self) -> None:
        left = docked_x("left", (200, 220), self.SCREEN)
        self.assertAlmostEqual(left + 100 + 110, 220 * DOCK_PEEK, delta=1)
        right = docked_x("right", (200, 220), self.SCREEN)
        self.assertAlmostEqual(1000 - (right + 100 - 110), 220 * DOCK_PEEK, delta=1)
        self.assertEqual((dock_angle("left"), dock_angle("right"), dock_angle(None)), (90.0, -90.0, 0.0))

    def test_tilt_leans_with_the_drag_and_is_capped(self) -> None:
        self.assertEqual(tilt_for_speed(400), 5.0)
        self.assertEqual(tilt_for_speed(-400), -5.0)
        self.assertEqual(tilt_for_speed(99999), MAX_TILT)
