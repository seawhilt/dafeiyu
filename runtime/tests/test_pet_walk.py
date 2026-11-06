import random
import unittest

from runtime.pet_geometry import WALK_MAX_PX, WALK_MIN_PX, plan_walk, walk_progress


class FixedRandom:
    """choice() takes the first option; uniform() returns its upper end."""

    def choice(self, options):
        return options[0]

    def uniform(self, low, high):
        return high


class PlanWalkTests(unittest.TestCase):
    # Reach for the body centre: 0..1000, a 100 px wide body.
    def plan(self, center_x: float, stride: float = 120.0, scale: float = 1.0, rnd=None):
        return plan_walk(center_x, 0.0, 1000.0, 50.0, scale, stride, rnd or FixedRandom())

    def test_it_walks_where_there_is_room(self) -> None:
        # 30 px of room on the left is under the 60 px shortest walk.
        direction, loops, distance = self.plan(100.0)
        self.assertEqual(direction, 1, "only the right side has room")
        self.assertEqual((loops, distance), (2, 240.0))
        self.assertEqual(self.plan(850.0)[0], -1)

    def test_whole_strides_only_and_never_off_screen(self) -> None:
        for seed in range(200):
            plan = self.plan(500.0, stride=90.0, rnd=random.Random(seed))
            assert plan is not None
            direction, loops, distance = plan
            self.assertEqual(distance, loops * 90.0)
            self.assertLessEqual(distance, WALK_MAX_PX + 90.0 / 2)
            end = 500.0 + direction * distance
            self.assertTrue(70.0 <= end <= 930.0, end)

    def test_a_long_stride_near_the_edge_is_shortened_to_fit(self) -> None:
        direction, loops, distance = self.plan(800.0 - 80.0, stride=240.0, rnd=random.Random(1))
        if direction == 1:
            self.assertEqual((loops, distance), (1, 930.0 - 720.0))

    def test_no_room_on_either_side_means_no_walk(self) -> None:
        self.assertIsNone(plan_walk(500.0, 400.0, 600.0, 50.0, 1.0, 120.0, FixedRandom()))

    def test_distances_grow_with_the_pet(self) -> None:
        small = self.plan(90.0, scale=0.5)
        assert small is not None
        self.assertEqual(small[2], 2 * 60.0)
        self.assertEqual(WALK_MIN_PX, 60.0)


class WalkProgressTests(unittest.TestCase):
    CURVE = [0.0, 0.0, 0.5, 1.0, 1.0]

    def test_without_a_curve_the_pace_is_even(self) -> None:
        self.assertEqual(walk_progress(None, 2, 0.25), 0.25)
        self.assertEqual(walk_progress([], 2, 1.5), 1.0)

    def test_the_curve_holds_still_on_standing_frames(self) -> None:
        self.assertEqual(walk_progress(self.CURVE, 1, 0.0), 0.0)
        self.assertEqual(walk_progress(self.CURVE, 1, 0.2), 0.0, "still frames do not move")
        self.assertAlmostEqual(walk_progress(self.CURVE, 1, 0.5), 0.5)
        self.assertEqual(walk_progress(self.CURVE, 1, 1.0), 1.0)

    def test_each_loop_covers_its_share(self) -> None:
        self.assertAlmostEqual(walk_progress(self.CURVE, 2, 0.5), 0.5)
        self.assertAlmostEqual(walk_progress(self.CURVE, 2, 0.75), 0.75)
        self.assertEqual(walk_progress(self.CURVE, 2, 2.0), 1.0)


if __name__ == "__main__":
    unittest.main()
