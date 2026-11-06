"""Where the character sits on screen, and how it is thrown and squashed."""

from __future__ import annotations

from collections.abc import Callable
from math import ceil, cos, exp, hypot, pi, radians, sin
from typing import Any, NamedTuple

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
# 边缘探头 (from dsh-pet-indesktop): a docked pet leans this far, and this share
# of its turned outline stays on screen; after a click it stands upright with
# most of itself showing.
DOCK_ANGLE = 45.0
DOCK_PEEK = 0.55
DOCK_ENGAGED_PEEK = 0.82
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


def docked_extent(pet_size: tuple[int, int], engaged: bool = False) -> tuple[float, float]:
    """Width and height of the docked pet's outline, turned or upright."""
    pet_width, pet_height = pet_size
    if engaged:
        return pet_width, pet_height
    angle = radians(DOCK_ANGLE)
    return (
        pet_width * cos(angle) + pet_height * sin(angle),
        pet_width * sin(angle) + pet_height * cos(angle),
    )


def docked_x(edge: str, pet_size: tuple[int, int], screen: tuple[int, int, int, int], engaged: bool = False) -> int:
    """The pet's x when docked: part of it peeks in from the screen side."""
    outline, _ = docked_extent(pet_size, engaged)
    left, _top, screen_width, _screen_height = screen
    visible = outline * (DOCK_ENGAGED_PEEK if engaged else DOCK_PEEK)
    if edge == "left":
        center_x = left + visible - outline / 2
    else:
        center_x = left + screen_width - visible + outline / 2
    return round(center_x - pet_size[0] / 2)


def dock_angle(edge: str | None, engaged: bool = False) -> float:
    """The pet's turn when docked, clockwise in degrees; the head leans in."""
    if engaged:
        return 0.0
    return {"left": DOCK_ANGLE, "right": -DOCK_ANGLE}.get(edge or "", 0.0)


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


# A released drag keeps flying when the pointer was still moving fast, falls
# under gravity, bounces off the screen edges and comes to rest on the floor.
# Numbers from dsh-pet-indesktop (pet/physics.py).
FLING_MIN_SPEED = 500.0  # px/s; a slower release just lets go
# Top release speed per 「甩出力度」 choice.
THROW_STRENGTH_CAPS = {"gentle": 3600.0, "standard": 4800.0, "strong": 7200.0, "crazy": 9000.0}
FLING_MAX_SPEED = THROW_STRENGTH_CAPS["standard"]
FLING_GRAVITY = 1400.0  # px/s², toward the floor
FLING_RESTITUTION = 0.68  # share of speed kept when hitting an edge
FLING_GROUND_FRICTION = 2.5  # per second, while sliding on the floor
FLING_FLOOR_STOP_SPEED = 120.0  # a landing slower than this does not bounce
FLING_WALL_STOP_SPEED = 60.0  # a wall hit slower than this stops instead of bouncing
FLING_REST_SPEED = 15.0  # on the floor and slower than this: at rest
FLING_SAMPLE_WINDOW_S = 0.08


class Fling(NamedTuple):
    """A pet in flight. Screen y grows downward; the floor is the bottom."""

    x: float
    y: float
    vx: float
    vy: float
    # A drop (「静止放手下落」) lands without bouncing.
    bouncy: bool = True


def fling_velocity(
    samples: list[tuple[float, float, float]], now: float, max_speed: float = FLING_MAX_SPEED,
) -> tuple[float, float] | None:
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
    cap = min(1.0, max_speed / speed)
    return vx * cap, vy * cap


def fling_bounds(pet_size: tuple[int, int], screen: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Where the pet's top-left may fly so all of it stays on `screen`."""
    left, top, width, height = screen
    return left, top, left + max(0, width - pet_size[0]), top + max(0, height - pet_size[1])


def fling_step(fling: Fling, seconds: float, bounds: tuple[int, int, int, int]) -> Fling | None:
    """Advance a throw or drop by `seconds`; None once it rests on the floor."""
    left, top, right, floor = bounds
    vx, vy = fling.vx, fling.vy + FLING_GRAVITY * seconds
    x, y = fling.x + vx * seconds, fling.y + vy * seconds
    if x < left or x > right:
        x = min(max(x, left), right)
        speed = 0.0 if abs(vx) < FLING_WALL_STOP_SPEED else abs(vx) * FLING_RESTITUTION
        vx = speed if x == left else -speed
    if y < top:
        y, vy = top, abs(vy) * FLING_RESTITUTION
    elif y >= floor:
        y = floor
        vx *= max(0.0, 1.0 - FLING_GROUND_FRICTION * seconds)
        vy = 0.0 if not fling.bouncy or abs(vy) < FLING_FLOOR_STOP_SPEED else -abs(vy) * FLING_RESTITUTION
        # Rest only once already on the floor, so the caller has moved the
        # pet onto it first.
        if vy == 0.0 and abs(vx) < FLING_REST_SPEED and fling.y >= floor:
            return None
    return Fling(x, y, vx, vy, fling.bouncy)


# 弹弓弹射: while dragging, a right click anchors the pet; pulling the pointer
# away and letting go launches it the other way. Distances grow with the pet's
# size. Numbers from dsh-pet-indesktop (pet/physics.py).
SLINGSHOT_MIN_DISTANCE = 24.0
SLINGSHOT_MAX_DISTANCE = 160.0
SLINGSHOT_BASE_SPEED = 900.0
SLINGSHOT_MAX_STRETCH = 1.3


def slingshot_pull(
    anchor_cursor: tuple[float, float], cursor: tuple[float, float], scale: float,
) -> tuple[float, float]:
    """The launch direction and strength: from the pointer back to where aiming began."""
    px, py = anchor_cursor[0] - cursor[0], anchor_cursor[1] - cursor[1]
    length = hypot(px, py)
    limit = SLINGSHOT_MAX_DISTANCE * scale
    if length > limit:
        px, py = px * limit / length, py * limit / length
    return px, py


def slingshot_launch(pull: tuple[float, float], scale: float, cap: float) -> tuple[float, float] | None:
    """Launch velocity for a pull, or None when it is too short to fire."""
    distance = hypot(*pull)
    low, high = SLINGSHOT_MIN_DISTANCE * scale, SLINGSHOT_MAX_DISTANCE * scale
    if distance < low or high <= low:
        return None
    progress = min(1.0, (distance - low) / (high - low))
    eased = 1 - (1 - progress) ** 2
    raw = SLINGSHOT_BASE_SPEED + (3 * cap - SLINGSHOT_BASE_SPEED) * eased
    # A soft cap keeps harder pulls faster while never passing the cap.
    speed = cap * (1 - exp(-raw / cap))
    return pull[0] / distance * speed, pull[1] / distance * speed


def slingshot_stretch(pull: tuple[float, float], scale: float) -> tuple[float, float]:
    """(width, height) scale of the pet stretched along the pull."""
    distance = hypot(*pull)
    if distance <= 1e-6:
        return 1.0, 1.0
    progress = min(1.0, distance / (SLINGSHOT_MAX_DISTANCE * scale))
    ux, uy = pull[0] / distance, pull[1] / distance
    stretch = 1 + (SLINGSHOT_MAX_STRETCH - 1) * progress
    squeeze = 1 - (1 - 1 / SLINGSHOT_MAX_STRETCH) * progress
    return hypot(stretch * ux, squeeze * uy), hypot(stretch * uy, squeeze * ux)


# Walking across the desktop: distances and the edge margin at scale 1.0, from
# dsh-pet-indesktop (pet/catalog.py).
WALK_MIN_PX = 60.0
WALK_MAX_PX = 240.0
WALK_MARGIN = 20.0


def plan_walk(
    center_x: float, left: float, right: float, half_width: float, scale: float, stride: float, rnd: Any,
) -> tuple[int, int, float] | None:
    """(direction, loops, distance) for a walk, or None when neither side has room.

    The distance is a whole number of strides so the feet never slide; near an
    edge the loop count drops, and a single loop that still does not fit is
    shortened to the room left.
    """
    low, high = left + WALK_MARGIN + half_width, right - WALK_MARGIN - half_width
    shortest = WALK_MIN_PX * scale
    rooms = [(direction, room) for direction, room in ((-1, center_x - low), (1, high - center_x)) if room >= shortest]
    if not rooms:
        return None
    direction, room = rnd.choice(rooms) if len(rooms) > 1 else rooms[0]
    distance = rnd.uniform(shortest, min(WALK_MAX_PX * scale, room))
    step = max(1.0, stride * scale)
    loops = max(1, round(distance / step))
    while loops > 1 and loops * step > room:
        loops -= 1
    return direction, loops, min(loops * step, room)


def walk_progress(curve: list[float] | None, loops: int, fraction: float) -> float:
    """Share of the walk covered after `fraction` of its time (0..1).

    `curve[i]` is how far one loop has got by source frame i, so standing
    frames hold the pet still and stepping frames carry it forward.
    """
    if fraction >= 1:
        return 1.0
    fraction = max(0.0, fraction)
    if not curve:
        return fraction
    loops = max(1, loops)
    position = fraction * loops
    loop = min(int(position), loops - 1)
    last = len(curve) - 1
    index = (position - loop) * last
    low = int(index)
    within = curve[low] + (curve[min(low + 1, last)] - curve[low]) * (index - low)
    return (loop + within) / loops


# A click presses the pet down at its feet and it springs straight back; every
# click restarts it. Same curve as dsh-pet-indesktop (pet/pet_sprite.py).
SQUASH_MS = 220
SQUASH_HEIGHT = 0.15  # shortest: 85% of its height
SQUASH_WIDTH = 0.10  # widest: 110% of its width


def squash_scale(elapsed_ms: float) -> tuple[float, float] | None:
    """(width, height) scale `elapsed_ms` after a click, None when done."""
    if elapsed_ms < 0 or elapsed_ms >= SQUASH_MS:
        return None
    pulse = sin(pi * elapsed_ms / SQUASH_MS)
    return 1 + SQUASH_WIDTH * pulse, 1 - SQUASH_HEIGHT * pulse
