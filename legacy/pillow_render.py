"""
Render styled subtitle overlays from a word-level transcript using Pillow,
then build a transparent overlay video and composite it on the base video.

Approach:
  1. Load word-level transcript
  2. Chunk words into display groups
  3. Compute state timeline (one state per sub-moment: word reveal, highlight,
     or blank gap)
  4. Render each state as a 1080x1920 RGBA PNG (caching identical states)
  5. Build a concat demuxer list with per-state durations
  6. Pipe concat into ffmpeg → transparent overlay video (PNG codec in MOV)
  7. Overlay onto base video with a final ffmpeg pass

Styles: hormozi, karaoke, minimal
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFilter, ImageFont


W, H = 1080, 1920
FPS = 30


# --------- data ---------

@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class State:
    start: float
    end: float
    # render_fn builds an RGBA image; None = blank (transparent)
    render_fn: Optional[Callable[[], Image.Image]] = None
    key: str = ""  # cache key for identical renders


# --------- font inventory ---------

FONTS = {
    "impact": ("/System/Library/Fonts/Supplemental/Impact.ttf", 0),
    "arial_black": ("/System/Library/Fonts/Supplemental/Arial Black.ttf", 0),
    "din_cond_bold": ("/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf", 0),
    "pt_sans_bold": ("/System/Library/Fonts/Supplemental/PTSans.ttc", 7),
    "pt_sans_narrow_bold": ("/System/Library/Fonts/Supplemental/PTSans.ttc", 2),
    "helvetica_bold": ("/System/Library/Fonts/HelveticaNeue.ttc", 1),
    "helvetica_cond_black": ("/System/Library/Fonts/HelveticaNeue.ttc", 9),
    "helvetica_medium": ("/System/Library/Fonts/HelveticaNeue.ttc", 10),
    "helvetica_thin": ("/System/Library/Fonts/HelveticaNeue.ttc", 12),
}


def load_font(name: str, size: int) -> ImageFont.FreeTypeFont:
    path, idx = FONTS[name]
    return ImageFont.truetype(path, size, index=idx)


# --------- transcript / chunking ---------

def load_words(path: Path) -> List[Word]:
    data = json.loads(path.read_text())
    out: List[Word] = []
    for seg in data["segments"]:
        for w in seg["words"]:
            t = w["word"].strip()
            if not t:
                continue
            out.append(Word(start=float(w["start"]), end=float(w["end"]), text=t))
    return out


def chunk_words(words: List[Word], max_words: int, max_chars: int, max_gap: float = 0.6) -> List[List[Word]]:
    chunks: List[List[Word]] = []
    cur: List[Word] = []
    cur_chars = 0
    for w in words:
        gap = (w.start - cur[-1].end) if cur else 0
        proposed = cur_chars + len(w.text) + (1 if cur else 0)
        if cur and (len(cur) >= max_words or proposed > max_chars or gap > max_gap):
            chunks.append(cur)
            cur = []
            cur_chars = 0
        cur.append(w)
        cur_chars = sum(len(x.text) for x in cur) + max(0, len(cur) - 1)
    if cur:
        chunks.append(cur)
    return chunks


TRIGGER_WORDS = {
    "важно", "никогда", "всегда", "лучший", "деньги", "бесплатно", "секрет",
    "never", "always", "best", "money", "free", "secret", "now", "stop",
}

def pick_keyword(chunk: List[Word]) -> int:
    best = -1
    best_len = 0
    for i, w in enumerate(chunk):
        clean = w.text.strip(".,!?;:—-\"'«»()…").lower()
        if clean in TRIGGER_WORDS:
            return i
        if len(clean) >= 6 and len(clean) > best_len:
            best_len = len(clean)
            best = i
    return best


# --------- rendering primitives ---------

def render_word(
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: Tuple[int, int, int, int],
    stroke_width: int = 0,
    stroke_fill: Tuple[int, int, int, int] = (0, 0, 0, 255),
    shadow: Optional[dict] = None,
) -> Image.Image:
    """Render a single word to a tight RGBA image."""
    bbox = font.getbbox(text, stroke_width=stroke_width)
    pad_x = stroke_width + 12
    pad_y = stroke_width + 12
    if shadow:
        pad_x += shadow.get("blur", 0) + abs(shadow.get("dx", 0))
        pad_y += shadow.get("blur", 0) + abs(shadow.get("dy", 0))
    w = bbox[2] - bbox[0] + pad_x * 2
    h = bbox[3] - bbox[1] + pad_y * 2
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    if shadow:
        shadow_img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow_img)
        sd.text(
            (pad_x - bbox[0] + shadow.get("dx", 0), pad_y - bbox[1] + shadow.get("dy", 0)),
            text, font=font, fill=shadow["color"],
        )
        blur = shadow.get("blur", 0)
        if blur:
            shadow_img = shadow_img.filter(ImageFilter.GaussianBlur(blur))
        img = Image.alpha_composite(img, shadow_img)

    d = ImageDraw.Draw(img)
    d.text(
        (pad_x - bbox[0], pad_y - bbox[1]),
        text, font=font, fill=fill,
        stroke_width=stroke_width, stroke_fill=stroke_fill,
    )
    return img


def layout_words_centered(
    word_imgs: List[Image.Image],
    canvas_size: Tuple[int, int],
    y_center: int,
    line_spacing: int = 10,
    word_gap: int = 22,
    max_line_width: int = 980,
) -> Image.Image:
    """Lay out word images in 1-2 centered lines, return the composed canvas."""
    canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    # group into lines
    lines: List[List[Image.Image]] = [[]]
    cur_w = 0
    for img in word_imgs:
        iw = img.width
        proposed = cur_w + iw + (word_gap if lines[-1] else 0)
        if lines[-1] and proposed > max_line_width:
            lines.append([img])
            cur_w = iw
        else:
            lines[-1].append(img)
            cur_w = proposed
    # total height
    line_heights = [max(im.height for im in line) for line in lines]
    total_h = sum(line_heights) + line_spacing * (len(lines) - 1)
    y = y_center - total_h // 2
    for line, lh in zip(lines, line_heights):
        line_w = sum(im.width for im in line) + word_gap * (len(line) - 1)
        x = (canvas.width - line_w) // 2
        for im in line:
            yy = y + (lh - im.height) // 2
            canvas.alpha_composite(im, (x, yy))
            x += im.width + word_gap
        y += lh + line_spacing
    return canvas


# --------- style: HORMOZI POP ---------

def style_hormozi(chunks: List[List[Word]], total_duration: float) -> List[State]:
    font = load_font("impact", 128)
    WHITE = (255, 255, 255, 255)
    BLACK = (0, 0, 0, 255)
    ACCENT = (250, 204, 21, 255)  # golden yellow
    SHADOW = {"color": (0, 0, 0, 190), "blur": 8, "dx": 0, "dy": 6}

    def build_frame(words_visible: List[Tuple[str, bool]]) -> Image.Image:
        imgs = []
        for text, is_key in words_visible:
            color = ACCENT if is_key else WHITE
            imgs.append(render_word(
                text.upper(), font,
                fill=color, stroke_width=10, stroke_fill=BLACK,
                shadow=SHADOW,
            ))
        return layout_words_centered(imgs, (W, H), y_center=int(H * 0.60))

    states: List[State] = []
    t_cursor = 0.0
    for chunk in chunks:
        key_idx = pick_keyword(chunk)
        # blank gap before chunk
        if chunk[0].start > t_cursor:
            states.append(State(t_cursor, chunk[0].start, None, "blank"))
        # one state per progressive word reveal
        for i, w in enumerate(chunk):
            s_start = w.start
            s_end = chunk[i + 1].start if i + 1 < len(chunk) else min(chunk[-1].end + 0.20, total_duration)
            if s_end <= s_start:
                s_end = s_start + 0.05
            visible = [
                (ww.text.strip(), j == key_idx)
                for j, ww in enumerate(chunk[: i + 1])
            ]
            key = "hormozi|" + "|".join(f"{t}:{k}" for t, k in visible)
            states.append(State(
                s_start, s_end,
                render_fn=(lambda v=tuple(visible): build_frame(list(v))),
                key=key,
            ))
        t_cursor = states[-1].end
    if t_cursor < total_duration:
        states.append(State(t_cursor, total_duration, None, "blank"))
    return states


# --------- style: KARAOKE HIGHLIGHT ---------

def style_karaoke(chunks: List[List[Word]], total_duration: float) -> List[State]:
    font = load_font("pt_sans_bold", 104)
    WHITE = (255, 255, 255, 255)
    DIM = (255, 255, 255, 110)
    ACCENT = (252, 211, 77, 255)  # amber
    SHADOW = {"color": (0, 0, 0, 200), "blur": 10, "dx": 0, "dy": 6}

    def build_frame(words_state: List[Tuple[str, str]]) -> Image.Image:
        # state: "past" | "current" | "future"
        imgs = []
        for text, st in words_state:
            if st == "current":
                imgs.append(render_word(
                    text, font,
                    fill=ACCENT, stroke_width=5, stroke_fill=(30, 30, 30, 255),
                    shadow=SHADOW,
                ))
            elif st == "past":
                imgs.append(render_word(
                    text, font,
                    fill=DIM, stroke_width=4, stroke_fill=(30, 30, 30, 180),
                    shadow=SHADOW,
                ))
            else:
                imgs.append(render_word(
                    text, font,
                    fill=WHITE, stroke_width=5, stroke_fill=(30, 30, 30, 255),
                    shadow=SHADOW,
                ))
        return layout_words_centered(imgs, (W, H), y_center=int(H * 0.70))

    states: List[State] = []
    t_cursor = 0.0
    for chunk in chunks:
        if chunk[0].start > t_cursor:
            states.append(State(t_cursor, chunk[0].start, None, "blank"))
        for i, w in enumerate(chunk):
            s_start = w.start
            s_end = chunk[i + 1].start if i + 1 < len(chunk) else min(chunk[-1].end + 0.25, total_duration)
            if s_end <= s_start:
                s_end = s_start + 0.05
            ws = []
            for j, ww in enumerate(chunk):
                if j < i:
                    ws.append((ww.text.strip(), "past"))
                elif j == i:
                    ws.append((ww.text.strip(), "current"))
                else:
                    ws.append((ww.text.strip(), "future"))
            key = "kara|" + "|".join(f"{t}:{s}" for t, s in ws)
            states.append(State(
                s_start, s_end,
                render_fn=(lambda v=tuple(ws): build_frame(list(v))),
                key=key,
            ))
        t_cursor = states[-1].end
    if t_cursor < total_duration:
        states.append(State(t_cursor, total_duration, None, "blank"))
    return states


# --------- style: MINIMAL EDITORIAL ---------

def style_minimal(chunks: List[List[Word]], total_duration: float) -> List[State]:
    font = load_font("helvetica_medium", 72)
    FILL = (242, 242, 242, 255)
    SHADOW = {"color": (0, 0, 0, 220), "blur": 18, "dx": 0, "dy": 8}

    def build_frame(text: str) -> Image.Image:
        # Pillow cannot blur the glyph fill easily; render the whole line then
        # place into canvas.
        img = render_word(
            text, font,
            fill=FILL, stroke_width=0, stroke_fill=(0, 0, 0, 0),
            shadow=SHADOW,
        )
        # if wider than max, wrap by words using layout_words_centered
        if img.width > 960:
            words = text.split(" ")
            imgs = [
                render_word(ww, font, fill=FILL, stroke_width=0,
                            stroke_fill=(0, 0, 0, 0), shadow=SHADOW)
                for ww in words
            ]
            return layout_words_centered(imgs, (W, H), y_center=int(H * 0.78),
                                         line_spacing=14, word_gap=18, max_line_width=960)
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(img, ((W - img.width) // 2, int(H * 0.78) - img.height // 2))
        return canvas

    states: List[State] = []
    t_cursor = 0.0
    for chunk in chunks:
        if chunk[0].start > t_cursor:
            states.append(State(t_cursor, chunk[0].start, None, "blank"))
        s_start = chunk[0].start
        s_end = min(chunk[-1].end + 0.30, total_duration)
        text = " ".join(w.text.strip() for w in chunk).lower()
        key = f"min|{text}"
        states.append(State(
            s_start, s_end,
            render_fn=(lambda t=text: build_frame(t)),
            key=key,
        ))
        t_cursor = s_end
    if t_cursor < total_duration:
        states.append(State(t_cursor, total_duration, None, "blank"))
    return states


STYLES = {
    "hormozi": (style_hormozi, dict(max_words=3, max_chars=18, max_gap=0.6)),
    "karaoke": (style_karaoke, dict(max_words=3, max_chars=22, max_gap=0.6)),
    "minimal": (style_minimal, dict(max_words=6, max_chars=32, max_gap=0.8)),
}


# --------- render timeline ---------

def build_frame_index(states: List[State], total_duration: float, fps: int) -> List[int]:
    """For each video frame, return the index of the active state (or -1 for blank)."""
    total_frames = int(round(total_duration * fps))
    result = [-1] * total_frames
    for i, st in enumerate(states):
        if st.render_fn is None:
            continue
        f_start = max(0, int(round(st.start * fps)))
        f_end = min(total_frames, int(round(st.end * fps)))
        for f in range(f_start, f_end):
            result[f] = i
    return result


def stream_overlay_video(states: List[State], total_duration: float, out_path: Path):
    """
    Render the overlay video by streaming PNG frames directly to ffmpeg
    via image2pipe. Each video frame gets the correct state image — frame
    accurate, no drift. Unique states are rendered once and cached.
    """
    import io

    total_frames = int(round(total_duration * FPS))
    frame_to_state = build_frame_index(states, total_duration, FPS)

    # Cache: state key -> PNG bytes
    blank_bytes = io.BytesIO()
    Image.new("RGBA", (W, H), (0, 0, 0, 0)).save(blank_bytes, "PNG", optimize=False)
    blank_bytes = blank_bytes.getvalue()

    state_bytes: dict = {}  # state index -> PNG bytes
    key_cache: dict = {}    # state key -> PNG bytes
    for i, st in enumerate(states):
        if st.render_fn is None:
            continue
        if st.key in key_cache:
            state_bytes[i] = key_cache[st.key]
            continue
        buf = io.BytesIO()
        st.render_fn().save(buf, "PNG", optimize=False)
        data = buf.getvalue()
        state_bytes[i] = data
        key_cache[st.key] = data

    cmd = [
        "ffmpeg", "-y",
        "-f", "image2pipe",
        "-framerate", str(FPS),
        "-vcodec", "png",
        "-i", "-",
        "-c:v", "png",
        "-pix_fmt", "rgba",
        str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for f in range(total_frames):
            sid = frame_to_state[f]
            data = state_bytes.get(sid, blank_bytes)
            proc.stdin.write(data)
        proc.stdin.close()
        rc = proc.wait()
        if rc != 0:
            err = proc.stderr.read().decode("utf-8", "replace")
            raise RuntimeError(f"ffmpeg failed: {err[-800:]}")
    finally:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()


def composite_final(base: Path, overlay: Path, out: Path):
    cmd = [
        "ffmpeg", "-y",
        "-i", str(base),
        "-i", str(overlay),
        "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        "-movflags", "+faststart",
        str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


# --------- entry point ---------

def main():
    if len(sys.argv) < 5:
        print("usage: pillow_render.py <transcript.json> <base_video.mp4> <style> <out.mp4>")
        print("styles:", ", ".join(STYLES))
        sys.exit(1)

    transcript = Path(sys.argv[1])
    base = Path(sys.argv[2])
    style_name = sys.argv[3]
    out = Path(sys.argv[4])

    if style_name not in STYLES:
        print("unknown style:", style_name)
        sys.exit(1)

    words = load_words(transcript)
    total_duration = max(w.end for w in words) + 0.5
    # clamp to actual video duration if known (best effort)
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(base)],
        capture_output=True, text=True,
    )
    try:
        vid_dur = float(probe.stdout.strip())
        total_duration = min(total_duration, vid_dur)
    except ValueError:
        pass

    style_fn, chunk_cfg = STYLES[style_name]
    chunks = chunk_words(words, **chunk_cfg)
    print(f"style={style_name}  chunks={len(chunks)}  duration={total_duration:.2f}s")

    states = style_fn(chunks, total_duration)
    print(f"  states={len(states)}")

    overlay_mov = Path("work") / f"overlay_{style_name}.mov"
    print("  streaming overlay video (frame-accurate)...")
    stream_overlay_video(states, total_duration, overlay_mov)

    print("  compositing final...")
    composite_final(base, overlay_mov, out)
    print(f"done: {out}")


if __name__ == "__main__":
    main()
