"""Generate the Twitch Shield icon set.

Run from the repo root: python scripts/icons.py
Requires Pillow. Committed PNGs are used by the build, so this is only needed
when the mark changes.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "icons"
SIZE = 1024
TOP = (172, 112, 255)
BOTTOM = (103, 45, 208)
SHIELD = (255, 255, 255)
TRIANGLE = (108, 48, 214)


def vertical_gradient(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size))
    pixels = image.load()
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        for x in range(size):
            pixels[x, y] = (*color, 255)
    return image


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def build_master() -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gradient = vertical_gradient(SIZE)
    canvas.paste(gradient, (0, 0), rounded_mask(SIZE, round(SIZE * 0.225)))

    draw = ImageDraw.Draw(canvas)

    # Soft inner edge light.
    draw.rounded_rectangle(
        (SIZE * 0.018, SIZE * 0.018, SIZE * 0.982, SIZE * 0.982),
        radius=round(SIZE * 0.21),
        outline=(255, 255, 255, 46),
        width=round(SIZE * 0.008),
    )

    # Shield silhouette.
    shield = [
        (SIZE * 0.293, SIZE * 0.225),
        (SIZE * 0.707, SIZE * 0.225),
        (SIZE * 0.707, SIZE * 0.505),
        (SIZE * 0.694, SIZE * 0.585),
        (SIZE * 0.655, SIZE * 0.664),
        (SIZE * 0.590, SIZE * 0.735),
        (SIZE * 0.500, SIZE * 0.798),
        (SIZE * 0.410, SIZE * 0.735),
        (SIZE * 0.345, SIZE * 0.664),
        (SIZE * 0.306, SIZE * 0.585),
        (SIZE * 0.293, SIZE * 0.505),
    ]
    draw.polygon(shield, fill=SHIELD)

    # Play mark.
    draw.polygon(
        [
            (SIZE * 0.443, SIZE * 0.382),
            (SIZE * 0.443, SIZE * 0.618),
            (SIZE * 0.610, SIZE * 0.500),
        ],
        fill=TRIANGLE,
    )

    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = build_master()

    for size in (16, 32, 48, 128, 512):
        resized = master.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(OUT / f"icon{size}.png", optimize=True)
        print(f"wrote {OUT / f'icon{size}.png'}")


if __name__ == "__main__":
    main()
