import unittest
from math import cos, radians, sin

from runtime.pet_geometry import (
    DOCK_ENGAGED_PEEK,
    DOCK_PEEK,
    MAX_TILT,
    bubble_top,
    dock_angle,
    dock_edge,
    docked_extent,
    docked_x,
    position_window,
    screen_outer_edges,
    tilt_allowance,
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

    def test_a_probing_pet_leans_in_and_shows_part_of_itself(self) -> None:
        width, height = docked_extent((200, 220), engaged=False)
        self.assertAlmostEqual(width, (200 + 220) * sin(radians(45)), delta=0.01)
        self.assertAlmostEqual(height, width, delta=0.01)
        # The visible share is measured on the turned outline.
        left = docked_x("left", (200, 220), self.SCREEN)
        self.assertAlmostEqual(left + 100 + width / 2, width * DOCK_PEEK, delta=1)
        right = docked_x("right", (200, 220), self.SCREEN)
        self.assertAlmostEqual(1000 - (right + 100 - width / 2), width * DOCK_PEEK, delta=1)
        self.assertEqual((dock_angle("left"), dock_angle("right"), dock_angle(None)), (45.0, -45.0, 0.0))

    def test_a_clicked_probing_pet_stands_upright_mostly_on_screen(self) -> None:
        self.assertEqual(docked_extent((200, 220), engaged=True), (200, 220))
        self.assertEqual(dock_angle("left", engaged=True), 0.0)
        left = docked_x("left", (200, 220), self.SCREEN, engaged=True)
        self.assertAlmostEqual(left + 200, 200 * DOCK_ENGAGED_PEEK, delta=1)
        right = docked_x("right", (200, 220), self.SCREEN, engaged=True)
        self.assertAlmostEqual(1000 - right, 200 * DOCK_ENGAGED_PEEK, delta=1)

    def test_tilt_leans_with_the_drag_and_is_capped(self) -> None:
        self.assertEqual(tilt_for_speed(400), 5.0)
        self.assertEqual(tilt_for_speed(-400), -5.0)
        self.assertEqual(tilt_for_speed(99999), MAX_TILT)


class SeamDockTests(unittest.TestCase):
    """The display seam between two screens must not accept a dock."""

    LEFT = (0, 0, 1000, 800)
    RIGHT = (1000, 0, 1000, 800)

    def test_only_real_display_edges_count(self) -> None:
        left_edges = screen_outer_edges(self.LEFT, [self.LEFT, self.RIGHT])
        right_edges = screen_outer_edges(self.RIGHT, [self.LEFT, self.RIGHT])
        # The inner sides are seams: the pet must not dock against them.
        self.assertEqual(left_edges, (True, False))
        self.assertEqual(right_edges, (False, True))

    def test_a_drop_at_the_seam_does_not_dock(self) -> None:
        left_edges = screen_outer_edges(self.LEFT, [self.LEFT, self.RIGHT])
        # A pet at the right edge of the left screen would slide between them.
        self.assertIsNone(dock_edge((810, 100, 200, 220), self.LEFT, left_edges))
        # The real outer edge still docks.
        self.assertEqual(dock_edge((-40, 100, 200, 220), self.LEFT, left_edges), "left")

    def test_stacked_screens_leave_the_side_edges_outer(self) -> None:
        upper = (0, 0, 1000, 800)
        lower = (0, 800, 1000, 800)
        self.assertEqual(screen_outer_edges(upper, [upper, lower]), (True, True))
        self.assertEqual(screen_outer_edges(lower, [upper, lower]), (True, True))

    def test_a_single_screen_keeps_both_sides(self) -> None:
        self.assertEqual(screen_outer_edges(self.LEFT, [self.LEFT]), (True, True))


class TiltAllowanceTests(unittest.TestCase):
    def test_allowance_covers_the_turned_bounding_box(self) -> None:
        width, height = 412, 344
        angle = radians(MAX_TILT)
        turned = width * sin(angle) + height * cos(angle)
        allowance = tilt_allowance((width, height))
        self.assertGreaterEqual(allowance, (turned - height) / 2)
        self.assertEqual(allowance, 45)

    def test_a_zero_lean_needs_no_extra_room(self) -> None:
        self.assertEqual(tilt_allowance((0, 0)), 0)
