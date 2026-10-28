import json
import unittest
from pathlib import Path

from runtime.animation_model import Player, crossfade_duration


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "assets/pet-manifest.json").read_text(encoding="utf-8"))


def clip(name: str, frames: int, loop: bool) -> dict:
    return {"frames": [f"{name}/{index}" for index in range(frames)], "frameMs": 100, "loop": loop}


SMALL = {
    "clips": {"idle": clip("idle", 3, True), "poke": clip("poke", 2, False)},
    "stateMap": {"IDLE": "idle"},
}


class PlayerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.player = Player(SMALL)

    def test_starts_on_the_idle_clip(self) -> None:
        self.assertEqual(self.player.active_clip_name, "idle")
        self.assertEqual(self.player.frame, "idle/0")

    def test_loop_wraps_and_reports_each_pass(self) -> None:
        self.assertIsNone(self.player.advance(250))
        self.assertEqual(self.player.frame, "idle/2")
        self.assertEqual(self.player.advance(100), "idle")
        self.assertEqual(self.player.frame, "idle/0")

    def test_one_shot_holds_its_last_frame_and_reports_once(self) -> None:
        self.assertTrue(self.player.play("poke"))
        self.assertEqual(self.player.advance(500), "poke")
        self.assertEqual(self.player.frame, "poke/1")
        self.assertIsNone(self.player.advance(500))

    def test_replaying_the_running_clip_does_not_restart_it(self) -> None:
        self.player.advance(150)
        self.player.play("idle")
        self.assertEqual(self.player.frame, "idle/1")

    def test_a_held_clip_restarts_when_played_again(self) -> None:
        self.player.play("poke")
        self.player.advance(500)
        self.player.play("poke")
        self.assertEqual(self.player.frame, "poke/0")

    def test_loop_flag_overrides_the_manifest(self) -> None:
        self.player.play("poke", loop=True)
        self.assertEqual(self.player.advance(200), "poke")
        self.assertEqual(self.player.frame, "poke/0")

    def test_unknown_clips_are_ignored(self) -> None:
        self.assertFalse(self.player.play("lunch"))
        self.assertEqual(self.player.active_clip_name, "idle")

    def test_reduced_motion_settles_a_one_shot_on_its_last_frame(self) -> None:
        # The helper never advances frames under reduced motion, so a one-shot
        # success/error clip must start out on its end pose, not frame 0.
        self.assertTrue(self.player.play("poke", settle_last_frame=True))
        self.assertEqual(self.player.frame, "poke/1")
        self.assertTrue(self.player.held)
        self.assertIsNone(self.player.advance(0))

    def test_reduced_motion_keeps_a_looping_clip_at_its_first_frame(self) -> None:
        self.player.play("idle", settle_last_frame=True)
        self.assertEqual(self.player.frame, "idle/0")
        self.assertFalse(self.player.held)

    def test_replaying_the_settled_clip_keeps_the_end_pose(self) -> None:
        self.player.play("poke", settle_last_frame=True)
        self.player.play("poke", settle_last_frame=True)
        self.assertEqual(self.player.frame, "poke/1")

    def test_drag_clips_switch_without_a_fade(self) -> None:
        self.assertIsNone(crossfade_duration("idle", "dragging"))
        self.assertIsNone(crossfade_duration("idle", "idle"))
        self.assertEqual(crossfade_duration("idle", "poke"), 0.10)


class ManifestTests(unittest.TestCase):
    def test_the_whale_manifest_loads(self) -> None:
        self.assertEqual(Player(MANIFEST).active_clip_name, MANIFEST["stateMap"]["IDLE"])

    def test_every_variant_exists(self) -> None:
        for primary, clips in MANIFEST["loopVariants"].items():
            self.assertEqual(clips[0], primary)
            for name in clips:
                self.assertIn(name, MANIFEST["clips"])

    def test_manifest_action_menu_only_names_existing_clips(self) -> None:
        for group in MANIFEST["actionMenu"]:
            for _label, name, _line in group["items"]:
                self.assertIn(name, MANIFEST["clips"], name)


if __name__ == "__main__":
    unittest.main()
