"""Crop Vector mascot to head-and-shoulders and export optimized assets."""
from pathlib import Path
from PIL import Image, ImageStat

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "images" / "vector-mascot.png"
OUT_DIR = ROOT / "images"

im = Image.open(SRC).convert("RGBA")
w, h = im.size
px = im.load()

# Find content bbox without numpy
min_x, min_y, max_x, max_y = w, h, 0, 0
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if max(r, g, b) > 18:
            if x < min_x:
                min_x = x
            if y < min_y:
                min_y = y
            if x > max_x:
                max_x = x
            if y > max_y:
                max_y = y

print(f"content bbox: L{min_x} T{min_y} R{max_x} B{max_y}")

content_h = max_y - min_y
cx = (min_x + max_x) // 2
crop_top = max(0, min_y - 12)
crop_bottom = min(h, min_y + int(content_h * 0.58))
side = crop_bottom - crop_top
crop_left = max(0, cx - side // 2)
crop_right = min(w, crop_left + side)
if crop_right - crop_left < side:
    crop_left = max(0, crop_right - side)
# Force square
side = min(crop_right - crop_left, crop_bottom - crop_top)
crop_right = crop_left + side
crop_bottom = crop_top + side

cropped = im.crop((crop_left, crop_top, crop_right, crop_bottom))
print(f"crop box: {(crop_left, crop_top, crop_right, crop_bottom)} -> {cropped.size}")

# Make near-black background transparent
cpx = cropped.load()
cw, ch = cropped.size
for y in range(ch):
    for x in range(cw):
        r, g, b, a = cpx[x, y]
        lum = max(r, g, b)
        if lum < 12:
            cpx[x, y] = (r, g, b, 0)
        elif lum < 28:
            new_a = int(a * ((lum - 12) / 16.0))
            cpx[x, y] = (r, g, b, new_a)


def export(img: Image.Image, name: str, size: int, webp_quality: int = 80):
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    png_path = OUT_DIR / f"{name}.png"
    webp_path = OUT_DIR / f"{name}.webp"
    resized.save(png_path, format="PNG", optimize=True)
    resized.save(webp_path, format="WEBP", quality=webp_quality, method=6)
    print(
        f"{name}: PNG {png_path.stat().st_size / 1024:.1f}KB, "
        f"WebP {webp_path.stat().st_size / 1024:.1f}KB @ {size}px"
    )
    return resized


export(cropped, "vector-avatar", 256, webp_quality=80)
export(cropped, "vector-favicon-32", 32, webp_quality=85)
export(cropped, "vector-favicon-48", 48, webp_quality=85)

# ICO favicon
base = cropped.resize((48, 48), Image.Resampling.LANCZOS)
ico_path = OUT_DIR / "favicon.ico"
base.save(
    ico_path,
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48)],
)
print(f"favicon.ico: {ico_path.stat().st_size / 1024:.1f}KB")

cropped.resize((512, 512), Image.Resampling.LANCZOS).save(
    OUT_DIR / "_vector-avatar-preview.png", optimize=True
)
print("done")
