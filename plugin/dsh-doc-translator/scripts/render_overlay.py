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

An item with "block": true is a paragraph read from a PDF text layer. It carries
"quads" (one per original line), "sources" (the original text of each line),
"align" ("left", "center" or "right") and "lineHeight" (distance between line
tops as a fraction of the page height), plus the exact style fields. Its old
lines are covered, and the translation is wrapped into the paragraph's width in
one size for every line: the size the original text would need in the chosen
font to keep its width. The paragraph keeps its own box when the translation
fits; otherwise it may grow into the plain background around it (checked
pixel by pixel, so it stops at borders, shapes and other text) but never past
the next text below it; only then is the size reduced. Words are never cut
unless the text has no room even at half size.

With "--assemble OUT.pdf DPI IMAGE..." the script instead joins the page images,
in order, into one PDF at OUT.pdf and writes nothing to stdout.
"""
import json
import math
import re
import subprocess
import sys
from functools import lru_cache

from PIL import Image, ImageChops, ImageDraw, ImageFont

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


def quad_box(q, w, h):
    xs = [q[i] / 1000.0 * w for i in range(0, 8, 2)]
    ys = [q[i] / 1000.0 * h for i in range(1, 8, 2)]
    return (min(xs), min(ys), max(xs), max(ys))


def wrap(text, font, width, break_words=False):
    """Greedy line breaking at spaces; text without spaces (Chinese, Japanese, Thai) breaks between characters.

    A word wider than the line is cut between characters only with `break_words`;
    otherwise it stays whole and the caller sees a line wider than `width`.
    """
    spaced = " " in text.strip() or LATIN_LIKE.match(text)
    tokens = re.findall(r"\S+\s*", text) if spaced else list(text)
    lines, current = [], ""
    for token in tokens:
        candidate = current + token
        if current and font.getlength(candidate.rstrip()) > width:
            lines.append(current.rstrip())
            current = token
        else:
            current = candidate
        while (break_words or not spaced) and font.getlength(current.rstrip()) > width and len(current.rstrip()) > 1:
            cut = len(current)
            while cut > 1 and font.getlength(current[:cut]) > width:
                cut -= 1
            lines.append(current[:cut])
            current = current[cut:]
    if current.strip():
        lines.append(current.rstrip())
    return lines or [""]


def is_free(image, box, background, tolerance=26, share=0.99):
    """Whether `box` shows only `background`: no text, border, shape or picture inside it."""
    w, h = image.size
    x1, y1, x2, y2 = max(0, int(box[0])), max(0, int(box[1])), min(w, int(math.ceil(box[2]))), min(h, int(math.ceil(box[3])))
    if x2 <= x1 or y2 <= y1:
        return False
    crop = image.crop((x1, y1, x2, y2)).convert("RGB")
    diff = ImageChops.difference(crop, Image.new("RGB", crop.size, background))
    worst = ImageChops.lighter(ImageChops.lighter(diff.getchannel(0), diff.getchannel(1)), diff.getchannel(2))
    histogram = worst.histogram()
    return sum(histogram[: tolerance + 1]) >= share * crop.size[0] * crop.size[1]


def neighbour_limits(box, obstacles, reach_y=0.0):
    """Half the distance to the nearest other text box beside the paragraph, to the left and to the right.

    A box counts when it overlaps the paragraph's rows or lies within `reach_y`
    above or below them: the text of a neighbouring column is rarely on exactly
    the same rows.
    """
    x1, y1, x2, y2 = box
    left = right = float("inf")
    for ox1, oy1, ox2, oy2 in obstacles:
        inside = ox1 >= x1 - 1 and ox2 <= x2 + 1 and oy1 >= y1 - 1 and oy2 <= y2 + 1
        if inside or min(y2 + reach_y, oy2) - max(y1 - reach_y, oy1) <= 0:
            continue
        if ox1 >= x2:
            right = min(right, (ox1 - x2) / 2)
        elif ox2 <= x1:
            left = min(left, (x1 - ox2) / 2)
    return left, right


def free_room(image, box, background, align, step, max_lines, obstacles=(), single_line=False):
    """The paragraph box grown into the free background around it.

    Sideways: centred text grows on both sides by the same amount, left-aligned
    text to the right and right-aligned text to the left, on each grown side up
    to 60% of the width for a one-line label and 15% for a paragraph, and never
    past half the distance to the next text box on the same rows or within two
    lines above or below. Down: whole lines of `step`, at most `max_lines`, over
    the grown width. Sideways growth keeps a quarter line (at least one increment)
    away from anything that is not background; downward growth stops at the
    last whole line that is still background.
    """
    bx1, by1, bx2, by2 = box
    w, _ = image.size
    increment = max(4.0, 0.03 * (bx2 - bx1))
    limit = (0.6 if single_line else 0.15) * (bx2 - bx1)

    def reach(direction):
        grown = 0.0
        while grown + increment <= limit:
            strip = (bx2 + grown, by1, bx2 + grown + increment, by2) if direction > 0 else (bx1 - grown - increment, by1, bx1 - grown, by2)
            # Keep the page margin free: text never grows into the outer 3% of the page.
            if strip[0] < 0.03 * w or strip[2] > 0.97 * w or not is_free(image, strip, background):
                break
            grown += increment
        # Keep a gutter of about a quarter line between the text and whatever stopped it.
        return max(0.0, grown - max(increment, 0.25 * step))

    # Text beside the paragraph keeps its own half of the space between them.
    near_left, near_right = neighbour_limits(box, obstacles, 2 * step)
    left = min(reach(-1), near_left) if align in ("center", "right") else 0.0
    right = min(reach(1), near_right) if align in ("center", "left") else 0.0
    if align == "center":
        left = right = min(left, right)
    x1, x2 = bx1 - left, bx2 + right
    bottom = by2
    for _ in range(max_lines):
        if not is_free(image, (x1, bottom, x2, bottom + step * 1.15), background):
            break
        bottom += step
    return x1, by1, x2, bottom


def room_below(box, obstacles, page_height, gap):
    """Lowest bottom a paragraph may reach: just above the next text under it, or the page bottom."""
    x1, y1, x2, y2 = box
    limit = page_height - gap
    for ox1, oy1, ox2, oy2 in obstacles:
        inside = ox1 >= x1 - 1 and ox2 <= x2 + 1 and oy1 >= y1 - 1 and oy2 <= y2 + 1
        if inside or oy1 < y2 - 1:
            continue
        if min(x2, ox2) - max(x1, ox1) > 0:
            limit = min(limit, oy1 - gap)
    return limit


SANS_CANDIDATES = ("Helvetica Neue", "Helvetica", "Arial", "Avenir Next", "Avenir", "Segoe UI", "Roboto", "Open Sans", "Noto Sans", "Liberation Sans", "Arial Narrow", "Trebuchet MS", "Gill Sans", "Verdana", "DejaVu Sans")
SERIF_CANDIDATES = ("Times New Roman", "Times", "Georgia", "Liberation Serif", "Noto Serif", "DejaVu Serif", "Baskerville", "Cambria")
SERIF_HINT = re.compile(r"serif|times|roman|georgia|garamond|baskerville|cambria|minion|palatino|book antiqua", re.I)


@lru_cache(maxsize=None)
def match(pattern):
    """`(file, index, family)` of the font fontconfig picks for `pattern`, or None."""
    try:
        out = subprocess.run(["fc-match", "-f", "%{file}|%{index}|%{family}", pattern], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    parts = out.split("|", 2)
    if len(parts) != 3 or not parts[0]:
        return None
    return parts[0], int(parts[1] or 0), parts[2].split(",")[0]


@lru_cache(maxsize=None)
def charset(path, index):
    """Code points the font maps, or None when the font cannot be read."""
    try:
        from fontTools.ttLib import TTFont
        font = TTFont(path, fontNumber=index, lazy=True)
        return frozenset(font.getBestCmap() or {})
    except Exception:  # noqa: BLE001 - any unreadable font only loses the coverage check
        return None


@lru_cache(maxsize=None)
def face(path, index, size):
    return ImageFont.truetype(path, size, index=index)


def covers(spec, text):
    chars = charset(spec[0], spec[1])
    return chars is None or all(ord(c) in chars for c in text if not c.isspace())


@lru_cache(maxsize=None)
def fallback_for(char, bold, italic):
    style = ("bold:" if bold else "") + ("italic:" if italic else "")
    found = match(f":{style}charset={ord(char):x}")
    return (found[0], found[1]) if found else None


class Face:
    """A font at one size that draws characters it lacks with a font that has them."""

    def __init__(self, spec, size, bold, italic):
        self.spec, self.size, self.bold, self.italic = spec, size, bold, italic
        self.main = face(spec[0], spec[1], size)

    def runs(self, text):
        chars = charset(self.spec[0], self.spec[1])
        out = []
        for c in text:
            spec = self.spec
            if chars is not None and not c.isspace() and ord(c) not in chars:
                spec = fallback_for(c, self.bold, self.italic) or self.spec
            if out and out[-1][0] == spec:
                out[-1][1] += c
            else:
                out.append([spec, c])
        return [(face(spec[0], spec[1], self.size), run) for spec, run in out]

    def getlength(self, text):
        return sum(font.getlength(run) for font, run in self.runs(text))

    def getmetrics(self):
        return self.main.getmetrics()

    def draw(self, draw, x, y, text, fill):
        for font, run in self.runs(text):
            draw.text((x, y), run, font=font, fill=fill, anchor="la")
            x += font.getlength(run)


def block_style(item):
    return (item.get("family") or "", bool(item.get("bold")), bool(item.get("italic")))


def choose_fonts(items, w, h, language):
    """For each style of the paragraphs on a page, the installed font whose width is closest to the PDF's own, and its width ratio.

    The original lines of every paragraph in that style are measured in each
    candidate at the PDF size and compared with their widths on the page; a
    candidate that lacks a letter of the translations is skipped. The ratio
    (page width over measured width, kept between 0.6 and 1.3) scales the PDF
    size of every paragraph in that style alike, so paragraphs that share a
    style in the PDF share a size in the translation.
    """
    groups = {}
    for item in items:
        if item.get("block") and LATIN_LIKE.match(item["text"]):
            groups.setdefault(block_style(item), []).append(item)
    chosen = {}
    for (family, bold, italic), group in groups.items():
        style = ("bold:" if bold else "") + ("italic:" if italic else "")
        lang = script_language(" ".join(i["text"] for i in group), language)
        names = SERIF_CANDIDATES if SERIF_HINT.search(family) else SANS_CANDIDATES
        specs = []
        own = match(f"{family}:{style}lang={lang}") if family else None
        for name in ((family,) if family else ()) + names:
            found = match(f"{name}:{style}lang={lang}")
            if found and (found[0], found[1]) not in specs and (found[2].lower().replace(" ", "") == name.lower().replace(" ", "") or found == own):
                specs.append((found[0], found[1]))
        letters = "".join(c for i in group for c in i["text"] if c.isalpha())
        best, best_error, best_ratio = None, None, 1.0
        for spec in specs:
            if not covers(spec, letters):
                continue
            measured = actual = 0.0
            for item in group:
                size = max(1, int(round(item["size"] * w)))
                for quad, src in zip(item["quads"], item.get("sources", [])):
                    if src.strip():
                        box = quad_box(quad, w, h)
                        measured += face(spec[0], spec[1], size).getlength(src)
                        actual += box[2] - box[0]
            if measured <= 0 or actual <= 0:
                continue
            error = abs(math.log(actual / measured))
            if best_error is None or error < best_error:
                best, best_error, best_ratio = spec, error, actual / measured
        if best is not None:
            chosen[(family, bold, italic)] = (best, min(1.3, max(0.6, best_ratio)))
    return chosen


def render_block(image, item, language, report, obstacles, fonts, cap=None):
    """Draw one paragraph; `cap` is the largest size it may use. Returns the size drawn."""
    w, h = image.size
    boxes = [quad_box(q, w, h) for q in item["quads"]]
    bx1, by1 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    bx2, by2 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    first_background = None
    for box in boxes:
        background, _, _ = sample(image, box)
        first_background = first_background or background
        pad_h, pad_v = max(2.0, 0.03 * (box[3] - box[1])), max(2.0, 0.08 * (box[3] - box[1]))
        ImageDraw.Draw(image).rectangle((box[0] - pad_h, box[1] - pad_v, box[2] + pad_h, box[3] + pad_v), fill=background)

    text = item["text"]
    lang = script_language(text, language)
    bold, italic = bool(item.get("bold")), bool(item.get("italic"))
    family = item.get("family") if LATIN_LIKE.match(text) else None
    chosen = fonts.get(block_style(item))
    spec, group_ratio = chosen if chosen is not None else (None, None)
    if spec is None:
        found = match(f"{family}:{'bold:' if bold else ''}{'italic:' if italic else ''}lang={lang}") if family else None
        spec = (found[0], found[1]) if found else (font_file(bold, lang, None, italic), 0)
    path = spec[0]
    base = item["size"] * w if item.get("size") else (boxes[0][3] - boxes[0][1]) * 0.85
    # The installed font may be wider or narrower than the PDF's own: size it so the original text keeps its width.
    sources = [src for src in item.get("sources", []) if src.strip()]
    measured = sum(Face(spec, max(1, int(round(base))), bold, italic).getlength(src) for src in sources)
    actual = sum(b[2] - b[0] for b, src in zip(boxes, item.get("sources", [])) if src.strip())
    if group_ratio is not None:
        ratio = group_ratio
    else:
        ratio = min(1.3, max(0.6, actual / measured)) if measured > 0 and actual > 0 else 1.0
    start = base * ratio
    if cap is not None:
        start = min(start, cap)
    step = item.get("lineHeight", 0) * h or (by2 - by1) * 1.2
    color = hex_color(item["color"]) if item.get("color") else (0, 0, 0)

    align = item.get("align", "left")
    below = max(by2, room_below((bx1, by1, bx2, by2), obstacles, h, max(4.0, 0.25 * step)))
    gx1, _, gx2, gbottom = free_room(image, (bx1, by1, bx2, by2), first_background, align, step, max_lines=4, obstacles=obstacles, single_line=len(boxes) == 1)
    # Two layouts: the paragraph's own box, and that box grown into free background (never past the text below).
    layouts = [(bx1, bx2, by2 + 0.3 * step), (gx1, gx2, min(max(by2 + 0.3 * step, gbottom), below))]
    floor = max(MIN_SIZE, start * 0.5)
    original_lines = max(1, len([src for src in item.get("sources", []) if src.strip()]))

    def attempt(size, max_lines, break_words=False):
        """The first layout where the text fits at `size` in at most `max_lines` lines, or None."""
        font = Face(spec, max(MIN_SIZE, int(round(size))), bold, italic)
        line_step = step * font.size / start
        ascent, descent = font.getmetrics()
        for x1, x2, bottom in layouts:
            width = (x2 - x1) * 1.02
            lines = wrap(text, font, width, break_words)
            height = line_step * (len(lines) - 1) + ascent + descent
            if len(lines) <= max_lines and height <= bottom - by1 + 1 and all(font.getlength(line) <= width + 1 for line in lines):
                return font, lines, line_step, x1, x2
        return None

    def sizes(low):
        size = start
        while size > low:
            yield size
            size -= max(0.5, size * 0.04)
        yield low

    # Keep the original number of lines while a small reduction is enough; then allow more lines; cut words only as a last resort.
    # Under a shared size the allowed reduction is smaller, so the paragraph stays at its style's size where it can.
    result = None
    for size in sizes(max(floor, start * (0.92 if cap is not None else 0.8))):
        result = attempt(size, original_lines)
        if result:
            break
    if result is None:
        for size in sizes(floor):
            result = attempt(size, 10_000)
            if result:
                break
    fits = result is not None
    if result is None:
        result = attempt(floor, 10_000, break_words=True)
    if result is None:
        # Nothing fits even at the smallest size: draw it there in the grown box and report the overflow.
        font = Face(spec, max(MIN_SIZE, int(round(floor))), bold, italic)
        x1, x2 = layouts[-1][0], layouts[-1][1]
        result = font, wrap(text, font, (x2 - x1) * 1.02, True), step * font.size / start, x1, x2
    font, lines, line_step, x1, x2 = result

    draw = ImageDraw.Draw(image)
    for i, line in enumerate(lines):
        line_w = font.getlength(line)
        x = x1 + (x2 - x1 - line_w) / 2 if align == "center" else x2 - line_w if align == "right" else x1
        font.draw(draw, x, by1 + i * line_step, line, color)
    report["lines"] += 1
    if not fits:
        report["overflow"] += 1
    if font.size < max(MIN_SIZE + 1, int(start * 0.8)):
        report["shrunk"] += 1
    report["fonts"].add(path)
    report["sizes"].append(font.size)
    return font.size


def size_caps(items, sizes):
    """Largest size for each paragraph so paragraphs of one PDF style get one size.

    `sizes` are the sizes each paragraph reached on its own. In a style with
    several paragraphs, every paragraph is capped at the smallest size among
    those within 90% of the style's median; a paragraph that needed less than
    that keeps its own smaller size.
    """
    groups = {}
    for index, item in enumerate(items):
        if index in sizes:
            key = block_style(item) + (item.get("size"), item.get("color"))
            groups.setdefault(key, []).append(index)
    caps = {}
    for members in groups.values():
        if len(members) < 2:
            continue
        values = sorted(sizes[i] for i in members)
        median = values[len(values) // 2]
        shared = min(v for v in values if v >= 0.9 * median)
        for i in members:
            caps[i] = shared
    return caps


def render_page(image, items, language, report, obstacles, margin, fonts, caps):
    """Draw every item of a page; returns the size drawn for each paragraph by item index."""
    sizes = {}
    for index, item in enumerate(items):
        if item.get("block"):
            sizes[index] = render_block(image, item, language, report, obstacles, fonts, caps.get(index))
        else:
            render_item(image, item, language, report, obstacles, margin)
    return sizes


def assemble(output, dpi, images):
    """Join page images into one PDF, one page per image."""
    pages = [Image.open(path).convert("RGB") for path in images]
    pages[0].save(output, "PDF", save_all=True, append_images=pages[1:], resolution=dpi)


def main():
    if sys.argv[1] == "--assemble":
        assemble(sys.argv[2], int(sys.argv[3]), sys.argv[4:])
        return
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
        fonts = choose_fonts(page["items"], w, h, spec.get("language"))
        # A trial pass finds the size each paragraph reaches alone; the real pass gives paragraphs of one style one size.
        trial = {"lines": 0, "overflow": 0, "shrunk": 0, "fonts": set(), "sizes": []}
        sizes = render_page(image.copy(), page["items"], spec.get("language"), trial, obstacles, margin, fonts, {})
        render_page(image, page["items"], spec.get("language"), report, obstacles, margin, fonts, size_caps(page["items"], sizes))
        image.save(page["output"], quality=92)
        pages_out.append(image)
    if spec.get("pdf") and pages_out:
        dpi = spec.get("dpi", 150)
        pages_out[0].save(spec["pdf"], "PDF", save_all=True, append_images=pages_out[1:], resolution=dpi)
    report["fonts"] = sorted(report["fonts"])
    print(json.dumps(report))


if __name__ == "__main__":
    main()
