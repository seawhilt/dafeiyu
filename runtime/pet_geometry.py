"""Where the character sits on screen, and how it is thrown and squashed."""

from __future__ import annotations

from collections.abc import Callable
from math import ceil, cos, exp, hypot, pi, radians, sin
from typing import NamedTuple

Rect = tuple[int, int, int, int]


def position_window(
    pet_position: tuple[int, int],
    pet_size: tuple[int, int],
    window_size: tuple[int, int],
    screen: tuple[int, int, int, int] | None,
    card_height: int = 0,
) -> tuple[int, int, int, int]:
    """Return window x/y and pet x/y, clamping the pet only at screen edges.

    Put the card below the pet when there is no room above it. Clamping the
    container must never rewrite a valid character position.
    """
    pet_x, pet_y = pet_position
    pet_width, pet_height = pet_size
    width, height = window_size
    center_offset = (width - pet_width) // 2
    top_offset = height - pet_height - 8
    if screen is None:
        return pet_x - center_offset, pet_y - top_offset, pet_x, pet_y

    left, top, screen_width, screen_height = screen
    pet_x = min(max(pet_x, left), max(left, left + screen_width - pet_width))
    pet_y = min(max(pet_y, top), max(top, top + screen_height - pet_height))
    if card_height and pet_y - card_height - 26 < top:
        top_offset = 8
    window_x = min(max(pet_x - center_offset, left), max(left, left + screen_width - width))
    window_y = min(max(pet_y - top_offset, top), max(top, top + screen_height - height))
    return window_x, window_y, pet_x, pet_y


def bubble_top(pet_y: int, pet_height: int, card_height: int, window_height: int) -> int:
    above = pet_y - card_height - 19
    desired = above if above >= 7 else pet_y + pet_height + 19
    return min(max(desired, 7), max(7, window_height - card_height - 7))


# A drop this close to a side of the screen docks the pet there.
DOCK_SNAP_DISTANCE = 16
# Share of the docked (rotated) pet that stays on screen: about the head.
DOCK_PEEK = 0.6
# The steepest lean while dragging, in degrees.
MAX_TILT = 14.0
# Drag speed, in pixels per second, per degree of lean.
TILT_SPEED_PER_DEGREE = 80.0


def screen_outer_edges(
    screen: Rect,
    screens: list[Rect],
    tolerance: int = 1,
) -> tuple[bool, bool]:
    """Which sides of `screen` are real display edges, not seams to a neighbour.

    Two displays meeting at a seam form one continuous desktop; docking a pet
    dropped against either side of the seam would make it slide between the
    screens. Only sides where no other display sits immediately beyond count.
    """
    left, top, width, height = screen
    right = left + width
    bottom = top + height

    def seam(edge: int, neighbour_edge: Callable[[Rect], int]) -> bool:
        return any(
            other != screen
            and abs(neighbour_edge(other) - edge) <= tolerance
            and other[1] < bottom
            and other[1] + other[3] > top
            for other in screens
        )

    left_seam = seam(left, lambda other: other[0] + other[2])
    right_seam = seam(right, lambda other: other[0])
    return (not left_seam, not right_seam)


def dock_edge(
    pet: Rect,
    screen: Rect,
    outer_edges: tuple[bool, bool] = (True, True),
) -> str | None:
    """The screen side a pet dropped at `pet` (x, y, width, height) docks on.

    `outer_edges` comes from `screen_outer_edges`: a seam between two displays
    is not a screen side to dock against.
    """
    pet_x, _pet_y, pet_width, _pet_height = pet
    left, _top, screen_width, _screen_height = screen
    if outer_edges[0] and pet_x <= left + DOCK_SNAP_DISTANCE:
        return "left"
    if outer_edges[1] and pet_x + pet_width >= left + screen_width - DOCK_SNAP_DISTANCE:
        return "right"
    return None


def docked_x(edge: str, pet_size: tuple[int, int], screen: tuple[int, int, int, int]) -> int:
    """The pet's x when docked: turned a quarter, only the head end shows."""
    pet_width, pet_height = pet_size
    left, _top, screen_width, _screen_height = screen
    visible = pet_height * DOCK_PEEK
    if edge == "left":
        center_x = left + visible - pet_height / 2
    else:
        center_x = left + screen_width - visible + pet_height / 2
    return round(center_x - pet_width / 2)


def dock_angle(edge: str | None) -> float:
    """The pet's turn when docked, clockwise in degrees; the head points in."""
    return {"left": 90.0, "right": -90.0}.get(edge or "", 0.0)


def tilt_for_speed(speed: float) -> float:
    """The lean for a horizontal drag speed: toward the motion, capped."""
    return min(MAX_TILT, max(-MAX_TILT, speed / TILT_SPEED_PER_DEGREE))


def tilt_allowance(pet_size: tuple[int, int]) -> int:
    """Extra vertical room below the anchor for a `MAX_TILT` lean.

    A centred rotation needs half the difference between the turned bounding
    box and the upright height. Keeping it in the window stops corners from
    being clipped while the pet is dragged.
    """
    width, height = pet_size
    angle = radians(MAX_TILT)
    turned = width * sin(angle) + height * cos(angle)
    return max(0, ceil((turned - height) / 2))


# A released drag keeps flying when the pointer was still moving fast.
FLING_MIN_SPEED = 900.0  # px/s over the last moment of the drag
FLING_MAX_SPEED = 4000.0
FLING_STOP_SPEED = 60.0
FLING_FRICTION = 4.0  # per second; speed falls to ~2% within one second
FLING_BOUNCE = 0.45  # share of speed kept when hitting a screen edge
FLING_SAMPLE_WINDOW_S = 0.08


class Fling(NamedTuple):
    x: float
    y: float
    vx: float
    vy: float


def fling_velocity(samples: list[tuple[float, float, float]], now: float) -> tuple[float, float] | None:
    """Release speed from (x, y, seconds) drag samples, or None for a plain drop."""
    if len(samples) < 2 or now - samples[-1][2] > FLING_SAMPLE_WINDOW_S:
        return None
    last = samples[-1]
    first = next(sample for sample in samples if last[2] - sample[2] <= FLING_SAMPLE_WINDOW_S)
    elapsed = last[2] - first[2]
    if elapsed <= 0:
        return None
    vx = (last[0] - first[0]) / elapsed
    vy = (last[1] - first[1]) / elapsed
    speed = hypot(vx, vy)
    if speed < FLING_MIN_SPEED:
        return None
    cap = min(1.0, FLING_MAX_SPEED / speed)
    return vx * cap, vy * cap


def fling_bounds(pet_size: tuple[int, int], screen: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Where the pet's top-left may fly so all of it stays on `screen`."""
    left, top, width, height = screen
    return left, top, left + max(0, width - pet_size[0]), top + max(0, height - pet_size[1])


def _bounce(position: float, speed: float, low: float, high: float) -> tuple[float, float]:
    if position < low:
        return low, abs(speed) * FLING_BOUNCE
    if position > high:
        return high, -abs(speed) * FLING_BOUNCE
    return position, speed


def fling_step(fling: Fling, seconds: float, bounds: tuple[int, int, int, int]) -> Fling | None:
    """Advance a throw by `seconds`; None once it has come to rest."""
    decay = exp(-FLING_FRICTION * seconds)
    vx, vy = fling.vx * decay, fling.vy * decay
    left, top, right, bottom = bounds
    x, vx = _bounce(fling.x + vx * seconds, vx, left, right)
    y, vy = _bounce(fling.y + vy * seconds, vy, top, bottom)
    if hypot(vx, vy) < FLING_STOP_SPEED:
        return None
    return Fling(x, y, vx, vy)


# A click squashes the pet at its feet and lets it spring back.
SQUASH_MS = 480
SQUASH_DEPTH = 0.12
SQUASH_DECAY_MS = 110.0
SQUASH_PERIOD_MS = 240.0
SQUASH_WIDEN = 0.5  # widening relative to the drop in height


def squash_scale(elapsed_ms: float) -> tuple[float, float] | None:
    """(width, height) scale `elapsed_ms` after a click, None when done."""
    if elapsed_ms < 0 or elapsed_ms >= SQUASH_MS:
        return None
    amount = SQUASH_DEPTH * exp(-elapsed_ms / SQUASH_DECAY_MS) * cos(2 * pi * elapsed_ms / SQUASH_PERIOD_MS)
    return 1 + amount * SQUASH_WIDEN, 1 - amount
