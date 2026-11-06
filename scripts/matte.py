"""Remove the white matte from frames that were cut out on a white background.

A semi-transparent pixel matted on white stores ``colour * a + 255 * (1 - a)``.
Dividing that white share back out restores the character's own colour, so
the pale fringe disappears on dark desktops and the art keeps its depth. Then
the outermost 1 px ring (the most contaminated one) is trimmed, and pixels
with alpha 1 are cleared: the matting left them across the whole background,
where they darken a light desktop by one level.

Method from MerZlin/dsh-pet-indesktop (MIT), pet/frameseq_provision.py.
Needs Pillow and numpy; this is a maintainer tool, not part of the runtime.
"""

from __future__ import annotations

# Edge pixels between these alphas are unblended. Below MIN the division is
# too imprecise to trust; at or above MAX the pixel is already solid.
UNBLEND_MIN_ALPHA = 21
UNBLEND_MAX_ALPHA = 250
ERODE_PX = 1
FAINT_ALPHA = 1
MATTE_VERSION = "unblend-white-1"


def clean_rgba(image):
    """Return a cleaned copy of an RGBA Pillow image."""
    import numpy as np
    from PIL import Image, ImageFilter

    if image.mode != "RGBA":
        raise ValueError(f"expected RGBA, got {image.mode}")
    pixels = np.asarray(image).astype(np.float32)
    rgb, alpha = pixels[..., :3], pixels[..., 3:4]
    edge = (alpha >= UNBLEND_MIN_ALPHA) & (alpha < UNBLEND_MAX_ALPHA)
    unblended = np.clip((rgb - (255 - alpha)) * 255 / np.maximum(alpha, 1), 0, 255)
    rgb = np.where(edge, unblended, rgb)
    eroded = image.getchannel("A").filter(ImageFilter.MinFilter(2 * ERODE_PX + 1))
    alpha = np.asarray(eroded).astype(np.float32)[..., None]
    alpha = np.where(alpha <= FAINT_ALPHA, 0, alpha)
    rgb = np.where(alpha == 0, 0, rgb)
    return Image.fromarray(np.rint(np.concatenate([rgb, alpha], axis=2)).astype(np.uint8), "RGBA")


def clean_file(path) -> None:
    """Clean one PNG frame in place."""
    from PIL import Image

    with Image.open(path) as image:
        cleaned = clean_rgba(image.convert("RGBA"))
    cleaned.save(path)
