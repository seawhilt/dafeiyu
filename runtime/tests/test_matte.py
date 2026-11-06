"""The frame importer's white-matte cleanup (needs Pillow and numpy)."""

import sys
import unittest
from pathlib import Path

try:
    import numpy  # noqa: F401
    from PIL import Image
except ImportError:
    Image = None

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))


@unittest.skipUnless(Image is not None, "the importer's maintainer dependencies are not installed")
class MatteTests(unittest.TestCase):
    def clean(self, *pixels):
        from matte import clean_rgba

        image = Image.new("RGBA", (len(pixels), 1))
        image.putdata(list(pixels))
        return list(clean_rgba(image).getdata())

    def test_a_half_transparent_edge_loses_its_white(self) -> None:
        # Navy (20, 30, 90) at alpha 128, matted on white.
        a = 128
        stored = tuple(round(c * a / 255 + 255 * (1 - a / 255)) for c in (20, 30, 90))
        solid = (20, 30, 90, 255)
        # Surround it with solid pixels so the 1px trim keeps it.
        from matte import clean_rgba

        image = Image.new("RGBA", (3, 3), solid)
        image.putpixel((1, 1), (*stored, a))
        cleaned = clean_rgba(image).getpixel((1, 1))
        self.assertEqual(cleaned[3], 128, "alpha stays")
        for got, want in zip(cleaned[:3], (20, 30, 90)):
            self.assertAlmostEqual(got, want, delta=2)

    def test_solid_and_nearly_invisible_pixels_keep_their_colour(self) -> None:
        from matte import clean_rgba

        image = Image.new("RGBA", (5, 5), (200, 210, 220, 255))
        image.putpixel((2, 2), (240, 240, 240, 10))
        cleaned = clean_rgba(image)
        self.assertEqual(cleaned.getpixel((2, 2))[:3], (240, 240, 240))
        self.assertEqual(cleaned.getpixel((0, 0)), (200, 210, 220, 255), "two pixels away is untouched")

    def test_the_outer_ring_is_trimmed_and_faint_background_cleared(self) -> None:
        pixels = self.clean((0, 0, 0, 1), (255, 255, 255, 200), (30, 30, 30, 255), (30, 30, 30, 255))
        self.assertEqual(pixels[0], (0, 0, 0, 0), "alpha 1 background is cleared")
        self.assertEqual(pixels[1][3], 0, "the outermost ring is trimmed")

    def test_only_rgba_images_are_accepted(self) -> None:
        from matte import clean_rgba

        with self.assertRaises(ValueError):
            clean_rgba(Image.new("RGB", (1, 1)))


if __name__ == "__main__":
    unittest.main()
