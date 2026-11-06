import unittest

from runtime.pet_geometry import (
    FLING_MAX_SPEED,
    FLING_RESTITUTION,
    SLINGSHOT_MAX_DISTANCE,
    SLINGSHOT_MIN_DISTANCE,
    THROW_STRENGTH_CAPS,
    FLING_MIN_SPEED,
    FLING_SAMPLE_WINDOW_S,
    SQUASH_MS,
    Fling,
    fling_bounds,
    fling_step,
    fling_velocity,
    slingshot_launch,
    slingshot_pull,
    slingshot_stretch,
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


class SlingshotTests(unittest.TestCase):
    def test_the_pull_points_away_from_the_cursor_and_is_capped(self) -> None:
        self.assertEqual(slingshot_pull((500.0, 500.0), (460.0, 530.0), scale=1.0), (40.0, -30.0))
        far = slingshot_pull((500.0, 500.0), (0.0, 500.0), scale=0.5)
        self.assertAlmostEqual(far[0], SLINGSHOT_MAX_DISTANCE * 0.5)
        self.assertEqual(far[1], 0.0)

    def test_a_short_pull_does_not_launch(self) -> None:
        self.assertIsNone(slingshot_launch((SLINGSHOT_MIN_DISTANCE - 1, 0.0), scale=1.0, cap=4800.0))

    def test_a_longer_pull_launches_faster_but_never_past_the_cap(self) -> None:
        short = slingshot_launch((40.0, 0.0), scale=1.0, cap=4800.0)
        full = slingshot_launch((SLINGSHOT_MAX_DISTANCE, 0.0), scale=1.0, cap=4800.0)
        assert short is not None and full is not None
        self.assertGreater(short[0], 0.0, "flies the way the pull points")
        self.assertGreater(full[0], short[0])
        self.assertLess(full[0], 4800.0)
        up = slingshot_launch((0.0, -100.0), scale=1.0, cap=4800.0)
        assert up is not None
        self.assertLess(up[1], 0.0)
        self.assertEqual(up[0], 0.0)

    def test_the_pet_stretches_along_the_pull(self) -> None:
        self.assertEqual(slingshot_stretch((0.0, 0.0), scale=1.0), (1.0, 1.0))
        sideways = slingshot_stretch((SLINGSHOT_MAX_DISTANCE, 0.0), scale=1.0)
        self.assertAlmostEqual(sideways[0], 1.3)
        self.assertLess(sideways[1], 1.0)
        upward = slingshot_stretch((0.0, -SLINGSHOT_MAX_DISTANCE), scale=1.0)
        self.assertAlmostEqual(upward[1], 1.3)


class SquashTests(unittest.TestCase):
    """A click presses the pet down and it springs straight back, as in dsh-pet-indesktop."""

    def test_it_starts_and_ends_at_full_size(self) -> None:
        self.assertEqual(squash_scale(0), (1.0, 1.0))
        self.assertIsNone(squash_scale(SQUASH_MS))
        self.assertIsNone(squash_scale(-1))
        self.assertEqual(SQUASH_MS, 220)

    def test_halfway_it_is_15_percent_shorter_and_10_percent_wider(self) -> None:
        width, height = squash_scale(SQUASH_MS / 2)
        self.assertAlmostEqual(width, 1.10)
        self.assertAlmostEqual(height, 0.85)

    def test_it_never_grows_taller_than_normal(self) -> None:
        for ms in range(0, SQUASH_MS, 5):
            width, height = squash_scale(ms)
            self.assertLessEqual(height, 1.0)
            self.assertGreaterEqual(width, 1.0)


if __name__ == "__main__":
    unittest.main()
