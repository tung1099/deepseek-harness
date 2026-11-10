#!/usr/bin/env python3
"""Replace the text lines of page images with translated text.

Reads a JSON spec from the path in argv[1]:
  { "dpi": 150, "language": "vi", "pdf": "out.pdf" | null,
    "pages": [ { "image": "in.png", "output": "out.png",
                 "items": [ { "quad": [x1,y1,...,x4,y4], "text": "..." } ] } ] }
Quad corners are on a 0..1000 scale in the order top-left, top-right,
bottom-right, bottom-left. For each item the old text is covered with the
colour sampled around it, then the translated text is drawn with a font that
covers the target language, sized to fit the line and rotated to the line angle.
An item read from a PDF text layer also carries "exact": true, "family",
"size" (fraction of the page width), "color" ("#rrggbb"), "bold" and "italic":
those are used instead of the guesses made from the image. A page may also carry
"obstacles": the boxes of every line on the page, translated or not. An exact line may
grow to the right, up to the next box on its row, instead of shrinking to the width of
the shorter original text.
Writes a JSON report to stdout.
"""
import json
import math
import re
import subprocess
import sys
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

MIN_SIZE = 7
MAX_GROWTH = 2.5  # an exact line may grow to this many times its original width at most
FALLBACK = {
    "regular": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "bold": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
}


def script_language(text, language):
    """Language tag to ask fontconfig for, from the characters actually drawn."""
    if re.search(r"[぀-ヿ]", text):
        return "ja"
    if re.search(r"[가-힯]", text):
        return "ko"
    if re.search(r"[一-鿿]", text):
        return language if language in ("zh-cn", "zh-tw", "ja", "ko") else "zh-cn"
    if re.search(r"[฀-๿]", text):
        return "th"
    if re.search(r"[؀-ۿ]", text):
        return "ar"
    if re.search(r"[֐-׿]", text):
        return "he"
    return language or "en"


# Text made only of Latin, Vietnamese, Greek and Cyrillic letters and common punctuation can use the
# document's own font family; other scripts need a font chosen for the script.
LATIN_LIKE = re.compile(r"^[\u0000-\u024f\u1e00-\u1eff\u0370-\u03ff\u0400-\u04ff\u2000-\u206f\u20a0-\u20cf]*$")


@lru_cache(maxsize=None)
def font_file(bold, lang, family=None, italic=False):
    style = ("bold:" if bold else "") + ("italic:" if italic else "")
    pattern = f"{family}:{style}lang={lang}" if family else f"sans:{style}lang={lang}"
    try:
        out = subprocess.run(["fc-match", "-f", "%{file}", pattern], capture_output=True, text=True, timeout=10).stdout.strip()
        if out:
            return out
    except (OSError, subprocess.SubprocessError):
        pass
    return FALLBACK["bold" if bold else "regular"]


@lru_cache(maxsize=None)
def load_font(path, size):
    return ImageFont.truetype(path, size)


def median(values):
    values = sorted(values)
    return values[len(values) // 2]


def luminance(pixel):
    return 0.299 * pixel[0] + 0.587 * pixel[1] + 0.114 * pixel[2]


def sample(image, box):
    """Background colour, ink colour and stroke weight of the text inside `box`.

    Stroke weight is the mean horizontal length of ink runs divided by the box
    height. Measured on a page with known bold lines it separates bold from
    regular text: regular lines stay below 0.16, bold lines above 0.17.
    """
    x1, y1, x2, y2 = [int(v) for v in box]
    w, h = image.size
    x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
    if x2 <= x1 or y2 <= y1:
        return (255, 255, 255), (0, 0, 0), 0.0
    ring = 4
    border = []
    for (a, b, c, d) in ((x1 - ring, y1 - ring, x2 + ring, y1), (x1 - ring, y2, x2 + ring, y2 + ring), (x1 - ring, y1, x1, y2), (x2, y1, x2 + ring, y2)):
        a, b, c, d = max(0, a), max(0, b), min(w, c), min(h, d)
        if c > a and d > b:
            border.extend(image.crop((a, b, c, d)).getdata())
    if not border:
        border = list(image.crop((x1, y1, x2, y2)).getdata())
    background = tuple(median([p[i] for p in border]) for i in range(3))
    crop = image.crop((x1, y1, x2, y2))
    cw, ch = crop.size
    pixels = list(crop.getdata())
    bg_lum = luminance(background)
    mask = [abs(luminance(p) - bg_lum) > 60 for p in pixels]
    runs = []
    for row in range(ch):
        length = 0
        for col in range(cw):
            if mask[row * cw + col]:
                length += 1
            elif length:
                runs.append(length)
                length = 0
        if length:
            runs.append(length)
    weight = (sum(runs) / len(runs)) / ch if runs else 0.0
    ink = [p for p, m in zip(pixels, mask) if m]
    if ink:
        ink.sort(key=lambda p: -abs(luminance(p) - bg_lum))
        top = ink[: max(1, len(ink) // 6)]
        color = tuple(int(sum(p[i] for p in top) / len(top)) for i in range(3))
    else:
        color = (0, 0, 0) if bg_lum > 128 else (255, 255, 255)
    return background, color, weight


def fit_text(text, path, max_w, top):
    """Largest size up to `top` whose text fits the width, never below MIN_SIZE."""
    low, high, best = MIN_SIZE, max(MIN_SIZE, int(top)), MIN_SIZE
    while low <= high:
        mid = (low + high) // 2
        if load_font(path, mid).getlength(text) <= max_w:
            best, low = mid, mid + 1
        else:
            high = mid - 1
    font = load_font(path, best)
    return font, font.getlength(text) > max_w


def room_to_the_right(box, obstacles, page_width, margin):
    """Right edge a line may reach: the next box on its row, or the mirror of the left margin."""
    x1, y1, x2, y2 = box
    height = y2 - y1
    limit = page_width - margin
    for ox1, oy1, ox2, oy2 in obstacles:
        if ox1 <= x1 + 1:
            continue
        overlap = min(y2, oy2) - max(y1, oy1)
        if overlap > 0.5 * min(height, oy2 - oy1):
            limit = min(limit, ox1 - max(4.0, 0.4 * height))
    return limit


def hex_color(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def render_item(image, item, language, report, obstacles, margin):
    w, h = image.size
    q = item["quad"]
    pts = [(q[i] / 1000.0 * w, q[i + 1] / 1000.0 * h) for i in range(0, 8, 2)]
    (x1, y1), (x2, y2), (x3, y3), (x4, y4) = pts
    box_w = math.hypot(x2 - x1, y2 - y1)
    box_h = math.hypot(x4 - x1, y4 - y1)
    angle = math.degrees(math.atan2(y2 - y1, x2 - x1))
    if abs(angle) > 8:
        angle = 0.0  # a spotting error, not a rotated page: draw upright
    cx, cy = sum(p[0] for p in pts) / 4, sum(p[1] for p in pts) / 4
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    bbox = (min(xs), min(ys), max(xs), max(ys))
    background, color, weight = sample(image, bbox)
    text = item["text"]
    lang = script_language(text, language)
    exact = bool(item.get("exact"))
    if exact:
        # Style read from the PDF itself.
        color = hex_color(item["color"]) if item.get("color") else color
        bold, italic = bool(item.get("bold")), bool(item.get("italic"))
        family = item.get("family") if LATIN_LIKE.match(text) else None
        top = item["size"] * w if item.get("size") else box_h * 0.85
    else:
        bold, italic, family = weight > 0.165, False, None
        top = box_h * 1.0
    path = font_file(bold, lang, family, italic)
    avail = box_w
    if exact and obstacles and abs(angle) < 1 and not (abs(cx - w / 2) < 0.04 * w):
        # Left-aligned text may use the free room to its right.
        limit = room_to_the_right((min(xs), min(ys), max(xs), max(ys)), obstacles, w, margin)
        avail = min(max(box_w, limit - min(xs)), box_w * MAX_GROWTH)
    font, overflow = fit_text(text, path, avail * 1.02, top)

    # Cover the old text with its background. The detected box hugs the letters, so stacked
    # diacritics and descenders reach past it: grow the cover along the line's own axes.
    ux, uy = ((x2 - x1) / box_w, (y2 - y1) / box_w) if box_w else (1.0, 0.0)
    vx, vy = ((x4 - x1) / box_h, (y4 - y1) / box_h) if box_h else (0.0, 1.0)
    pad_h, pad_v = (max(2.0, 0.03 * box_h), max(2.0, 0.06 * box_h)) if exact else (max(2.0, 0.05 * box_h), max(3.0, 0.20 * box_h))
    def grow(px, py, sx, sy):
        return (px + sx * pad_h * ux + sy * pad_v * vx, py + sx * pad_h * uy + sy * pad_v * vy)
    cover = [grow(x1, y1, -1, -1), grow(x2, y2, 1, -1), grow(x3, y3, 1, 1), grow(x4, y4, -1, 1)]
    ImageDraw.Draw(image).polygon(cover, fill=background)

    # Draw the new text upright on a transparent layer, then rotate it into place.
    ascent, descent = font.getmetrics()
    text_w = max(1, int(math.ceil(font.getlength(text))))
    layer_h = ascent + descent
    layer = Image.new("RGBA", (text_w + 4, layer_h + 4), (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((2, 2), text, font=font, fill=color + (255,))
    centered = abs(cx - w / 2) < 0.04 * w and text_w < avail * 1.02
    left = cx - text_w / 2 if centered else x1
    if text_w > avail * 1.02:
        left = x1
    center_x = left + text_w / 2
    rotated = layer.rotate(-angle, resample=Image.BICUBIC, expand=True)
    # The text block is centred on the line's own centre line.
    offset = (cx - (x1 + x2) / 2, cy - (y1 + y2) / 2)
    paste_x = int(center_x + offset[0] - rotated.width / 2)
    paste_y = int(cy - rotated.height / 2)
    image.paste(rotated, (paste_x, paste_y), rotated)
    report["lines"] += 1
    if overflow:
        report["overflow"] += 1
    if font.size < max(MIN_SIZE + 1, int(top * 0.6)):
        report["shrunk"] += 1
    report["fonts"].add(path)
    report["sizes"].append(font.size)


def main():
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    pages_out = []
    report = {"lines": 0, "overflow": 0, "shrunk": 0, "fonts": set(), "sizes": []}
    for page in spec["pages"]:
        image = Image.open(page["image"]).convert("RGB")
        w, h = image.size
        obstacles = []
        for q in page.get("obstacles", []):
            xs, ys = [q[i] / 1000.0 * w for i in range(0, 8, 2)], [q[i] / 1000.0 * h for i in range(1, 8, 2)]
            obstacles.append((min(xs), min(ys), max(xs), max(ys)))
        margin = max(0.0, min((o[0] for o in obstacles), default=0.0))
        for item in page["items"]:
            render_item(image, item, spec.get("language"), report, obstacles, margin)
        image.save(page["output"], quality=92)
        pages_out.append(image)
    if spec.get("pdf") and pages_out:
        dpi = spec.get("dpi", 150)
        pages_out[0].save(spec["pdf"], "PDF", save_all=True, append_images=pages_out[1:], resolution=dpi)
    report["fonts"] = sorted(report["fonts"])
    print(json.dumps(report))


if __name__ == "__main__":
    main()
