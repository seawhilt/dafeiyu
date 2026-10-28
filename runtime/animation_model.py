"""Clip playback for the Windows pet program.

No Qt dependency. The daemon's pet director (src/pet-director.js) decides
which clip plays; this module only times frames.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


DRAG_CLIPS = {"dragging", "dragging_release"}


def crossfade_duration(previous_clip: str, current_clip: str) -> float | None:
    """Fade clip changes only; never blend successive 24 fps video frames."""
    if previous_clip == current_clip or previous_clip in DRAG_CLIPS or current_clip in DRAG_CLIPS:
        return None
    return 0.10


@dataclass(frozen=True)
class Clip:
    name: str
    frames: tuple[str, ...]
    frame_ms: int
    loop: bool


class Player:
    """Plays the clip the daemon chose and reports the end of each pass.

    Since the daemon's pet director decides every animation, the helper only
    needs this: frame timing, looping or holding the last frame, and a report
    when a pass of the clip ends so the director can pick what follows.
    """

    def __init__(self, manifest: dict[str, Any]) -> None:
        self.clips = {
            name: Clip(
                name=name,
                frames=tuple(value["frames"]),
                frame_ms=int(value["frameMs"]),
                loop=bool(value["loop"]),
            )
            for name, value in manifest["clips"].items()
        }
        self.active_clip_name = manifest["stateMap"]["IDLE"]
        self.loop = self.active_clip.loop
        self.frame_index = 0
        self.frame_elapsed_ms = 0
        self.held = False

    @property
    def active_clip(self) -> Clip:
        return self.clips[self.active_clip_name]

    @property
    def frame(self) -> str:
        return self.active_clip.frames[self.frame_index]

    def play(self, clip_name: str, loop: bool | None = None, settle_last_frame: bool = False) -> bool:
        """Switch clips; playing the running clip again does not restart it.

        `settle_last_frame` is for reduced motion: a one-shot clip then rests
        on its end pose (the result) instead of being frozen on its first
        frame, because the helper never animates it under reduced motion.
        """
        if clip_name not in self.clips:
            return False
        if clip_name == self.active_clip_name and not self.held:
            if settle_last_frame:
                self._hold_last_frame()
            return True
        self.active_clip_name = clip_name
        self.loop = self.active_clip.loop if loop is None else loop
        self.frame_index = 0
        self.frame_elapsed_ms = 0
        self.held = False
        if settle_last_frame:
            self._hold_last_frame()
        return True

    def _hold_last_frame(self) -> None:
        """Rest on a one-shot clip's final pose; looping clips stay put."""
        clip = self.active_clip
        if self.loop or not clip.frames:
            return
        self.frame_index = len(clip.frames) - 1
        self.frame_elapsed_ms = 0
        self.held = True

    def advance(self, elapsed_ms: int) -> str | None:
        """Move on; return the clip name when a pass ended during this step."""
        clip = self.active_clip
        if self.held or elapsed_ms < 0 or not clip.frames:
            return None
        steps, self.frame_elapsed_ms = divmod(self.frame_elapsed_ms + elapsed_ms, clip.frame_ms)
        next_frame = self.frame_index + steps
        if next_frame < len(clip.frames):
            self.frame_index = next_frame
            return None
        if self.loop:
            self.frame_index = next_frame % len(clip.frames)
        else:
            self.frame_index = len(clip.frames) - 1
            self.frame_elapsed_ms = 0
            self.held = True
        return clip.name
