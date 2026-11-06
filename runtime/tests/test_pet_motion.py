import unittest

from runtime.pet_geometry import (
    FLING_MAX_SPEED,
    FLING_RESTITUTION,
    THROW_STRENGTH_CAPS,
    FLING_MIN_SPEED,
    FLING_SAMPLE_WINDOW_S,
    SQUASH_MS,
    Fling,
    fling_bounds,
    fling_step,
    fling_velocity,
    squash_scale,
)

SCREEN = (0, 0, 1920, 1040)
PET = (200, 160)


class FlingVelocityTests(unittest.TestCase):
    def test_a_quick_flick_throws_the_pet(self) -> None:
        samples = [(100.0, 500.0, 1.00), (130.0, 495.0, 1.02), (190.0, 485.0, 1.04)]
        velocity = fling_velocity(samples, now=1.05)
        assert velocity is not None
        self.assertAlmostEqual(velocity[0], 2250.0)
        self.assertAlmostEqual(velocity[1], -375.0)

    def test_a_slow_drag_just_drops(self) -> None:
        samples = [(100.0, 500.0, 1.00), (110.0, 500.0, 1.04)]
        self.assertIsNone(fling_velocity(samples, now=1.05))
        self.assertEqual(FLING_MIN_SPEED, 500.0)

    def test_holding_still_before_letting_go_just_drops(self) -> None:
        samples = [(100.0, 500.0, 1.00), (190.0, 500.0, 1.04)]
        self.assertIsNone(fling_velocity(samples, now=1.04 + FLING_SAMPLE_WINDOW_S + 0.01))

    def test_only_the_last_moment_of_the_drag_counts(self) -> None:
        # A fast start followed by a slow finish must not be thrown.
        samples = [(0.0, 0.0, 0.0), (900.0, 0.0, 0.1), (905.0, 0.0, 0.2), (910.0, 0.0, 0.25)]
        self.assertIsNone(fling_velocity(samples, now=0.25))

    def test_a_wild_flick_is_capped(self) -> None:
        samples = [(0.0, 0.0, 1.00), (900.0, 0.0, 1.01)]
        velocity = fling_velocity(samples, now=1.01)
        assert velocity is not None
        self.assertAlmostEqual(velocity[0], FLING_MAX_SPEED)
        self.assertAlmostEqual(velocity[1], 0.0)

    def test_the_throw_strength_sets_the_cap(self) -> None:
        samples = [(0.0, 0.0, 1.00), (900.0, 0.0, 1.01)]
        for strength, cap in THROW_STRENGTH_CAPS.items():
            velocity = fling_velocity(samples, now=1.01, max_speed=cap)
            assert velocity is not None
            self.assertAlmostEqual(velocity[0], cap, msg=strength)
        self.assertEqual(FLING_MAX_SPEED, THROW_STRENGTH_CAPS["standard"])
        self.assertLess(THROW_STRENGTH_CAPS["gentle"], THROW_STRENGTH_CAPS["crazy"])

    def test_too_few_samples_never_throw(self) -> None:
        self.assertIsNone(fling_velocity([], now=1.0))
        self.assertIsNone(fling_velocity([(0.0, 0.0, 1.0)], now=1.0))


class FlingStepTests(unittest.TestCase):
    """Screen y grows downward here (Qt); the floor is the bottom bound."""

    def settle(self, fling: Fling, limit: int = 600) -> tuple[Fling, int]:
        bounds = fling_bounds(PET, SCREEN)
        last, steps = fling, 0
        current: Fling | None = fling
        while current is not None and steps < limit:
            last = current
            current = fling_step(current, 1 / 60, bounds)
            steps += 1
        self.assertIsNone(current, "the throw comes to rest")
        return last, steps

    def test_the_pet_stays_fully_on_screen(self) -> None:
        self.assertEqual(fling_bounds(PET, SCREEN), (0, 0, 1720, 880))
        self.assertEqual(fling_bounds((3000, 3000), SCREEN), (0, 0, 0, 0))

    def test_a_throw_arcs_down_and_lands_on_the_floor(self) -> None:
        last, steps = self.settle(Fling(500.0, 200.0, 1500.0, -600.0))
        self.assertLess(steps, 8 * 60, "comes to rest within eight seconds")
        self.assertAlmostEqual(last.y, 880.0, delta=1, msg="rests on the floor")
        self.assertGreater(last.x, 500.0)

    def test_gravity_pulls_a_flying_pet_down(self) -> None:
        bounds = fling_bounds(PET, SCREEN)
        fling = fling_step(Fling(500.0, 300.0, 0.0, -100.0), 0.5, bounds)
        assert fling is not None
        self.assertGreater(fling.vy, 0.0, "falling after half a second")

    def test_the_pet_bounces_off_a_wall_and_keeps_some_speed(self) -> None:
        bounds = fling_bounds(PET, SCREEN)
        fling = fling_step(Fling(1710.0, 400.0, 3000.0, 0.0), 1 / 60, bounds)
        assert fling is not None
        self.assertEqual(fling.x, 1720.0)
        self.assertAlmostEqual(fling.vx, -3000.0 * FLING_RESTITUTION)

    def test_a_slow_wall_hit_stops_instead_of_sticking_and_bouncing(self) -> None:
        bounds = fling_bounds(PET, SCREEN)
        fling = fling_step(Fling(1719.5, 400.0, 40.0, 0.0), 1 / 60, bounds)
        assert fling is not None
        self.assertEqual(fling.vx, 0.0)

    def test_the_floor_and_ceiling_bounce(self) -> None:
        bounds = fling_bounds(PET, SCREEN)
        up = fling_step(Fling(500.0, 5.0, 0.0, -3000.0), 1 / 60, bounds)
        assert up is not None
        self.assertEqual(up.y, 0.0)
        self.assertGreater(up.vy, 0.0)
        down = fling_step(Fling(500.0, 875.0, 0.0, 3000.0), 1 / 60, bounds)
        assert down is not None
        self.assertEqual(down.y, 880.0)
        self.assertLess(down.vy, 0.0)

    def test_a_drop_falls_and_lands_without_bouncing(self) -> None:
        bounds = fling_bounds(PET, SCREEN)
        current: Fling | None = Fling(500.0, 100.0, 0.0, 0.0, bouncy=False)
        heights = []
        while current is not None:
            heights.append(current.y)
            current = fling_step(current, 1 / 60, bounds)
        self.assertEqual(heights, sorted(heights), "only ever goes down")
        # 780 px under 1400 px/s² takes about 1.06 s.
        self.assertLess(len(heights), 70)

    def test_letting_go_on_the_floor_ends_at_once(self) -> None:
        bounds = fling_bounds(PET, SCREEN)
        self.assertIsNone(fling_step(Fling(500.0, 880.0, 0.0, 0.0, bouncy=False), 1 / 60, bounds))


class SquashTests(unittest.TestCase):
    def test_a_click_squashes_the_pet_then_springs_back(self) -> None:
        start = squash_scale(0)
        assert start is not None
        self.assertLess(start[1], 1.0, "squashed down")
        self.assertGreater(start[0], 1.0, "and wider")
        self.assertIsNone(squash_scale(SQUASH_MS))
        self.assertIsNone(squash_scale(-1))

    def test_it_overshoots_once_and_stays_gentle(self) -> None:
        heights = [squash_scale(ms) for ms in range(0, SQUASH_MS, 10)]
        self.assertTrue(any(scale is not None and scale[1] > 1.0 for scale in heights), "springs past its size")
        for scale in heights:
            assert scale is not None
            self.assertTrue(0.8 < scale[1] < 1.2)
            self.assertTrue(0.8 < scale[0] < 1.2)

    def test_it_ends_close_to_its_normal_size(self) -> None:
        last = squash_scale(SQUASH_MS - 1)
        assert last is not None
        self.assertAlmostEqual(last[0], 1.0, delta=0.02)
        self.assertAlmostEqual(last[1], 1.0, delta=0.02)


if __name__ == "__main__":
    unittest.main()
