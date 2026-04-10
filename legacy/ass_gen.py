"""
Generate ASS (SubStation Alpha) subtitle files from a faster-whisper
word-level transcript JSON, in several styles.

ASS coordinate system here is PlayResX=1080, PlayResY=1920 (9:16).

Styles:
  - hormozi:  2-3 words per screen, pop-in scale bounce, keyword highlight
  - karaoke:  3-4 words per screen, word-sync fill sweep
  - minimal:  single line, lowercase, gentle fade, bottom-third
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List


PLAY_W = 1080
PLAY_H = 1920


# -------- helpers --------

def fmt_time(t: float) -> str:
    """ASS timestamp: H:MM:SS.cs (centiseconds)."""
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def clean_word(w: str) -> str:
    return w.strip()


@dataclass
class Word:
    start: float
    end: float
    text: str


def load_words(transcript_path: Path) -> List[Word]:
    data = json.loads(transcript_path.read_text())
    words: List[Word] = []
    for seg in data["segments"]:
        for w in seg.get("words", []):
            t = clean_word(w["word"])
            if not t:
                continue
            words.append(Word(start=float(w["start"]), end=float(w["end"]), text=t))
    return words


def chunk_words(words: List[Word], max_words: int, max_chars: int) -> List[List[Word]]:
    """Group words into display chunks. Break on long gaps or when full."""
    chunks: List[List[Word]] = []
    cur: List[Word] = []
    cur_chars = 0
    for i, w in enumerate(words):
        gap = (w.start - cur[-1].end) if cur else 0
        proposed = cur_chars + len(w.text) + (1 if cur else 0)
        if cur and (len(cur) >= max_words or proposed > max_chars or gap > 0.6):
            chunks.append(cur)
            cur = []
            cur_chars = 0
        cur.append(w)
        cur_chars += len(w.text) + (1 if cur_chars else 0)
    if cur:
        chunks.append(cur)
    return chunks


# Keyword highlighting: pick emphasised words by simple heuristic
# (longest word in chunk if length >= 5, or explicit trigger words)
TRIGGER_RU = {"важно", "никогда", "всегда", "лучший", "деньги", "бесплатно", "секрет"}
TRIGGER_EN = {"never", "always", "best", "money", "free", "secret", "now", "stop"}

def pick_keyword(chunk: List[Word]) -> int:
    best = -1
    best_len = 0
    for i, w in enumerate(chunk):
        stripped = w.text.strip(".,!?;:—-—\"'«»()").lower()
        if stripped in TRIGGER_RU or stripped in TRIGGER_EN:
            return i
        if len(stripped) >= 5 and len(stripped) > best_len:
            best_len = len(stripped)
            best = i
    return best


# -------- ASS header --------

def ass_header(style_block: str) -> str:
    return f"""[Script Info]
ScriptType: v4.00+
PlayResX: {PLAY_W}
PlayResY: {PLAY_H}
ScaledBorderAndShadow: yes
WrapStyle: 2
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{style_block}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


# -------- style 1: Hormozi-pop --------
# Bold all-caps, big, thick outline, pop-bounce per word, accent keyword.
def build_hormozi(words: List[Word]) -> str:
    # Colors in ASS are &HAABBGGRR&
    # White fill, black outline, bright yellow accent for keywords
    style_block = (
        "Style: Main,Impact,120,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,"
        "1,0,0,0,100,100,2,0,1,8,2,5,60,60,0,1\n"
        "Style: Accent,Impact,120,&H0017E5FC,&H000000FF,&H00000000,&H80000000,"
        "1,0,0,0,100,100,2,0,1,8,2,5,60,60,0,1"
    )
    events: List[str] = []
    chunks = chunk_words(words, max_words=3, max_chars=18)
    for chunk in chunks:
        key_idx = pick_keyword(chunk)
        chunk_start = chunk[0].start
        chunk_end = chunk[-1].end + 0.15
        # For each prefix state, emit a dialogue event for progressive reveal.
        for i, w in enumerate(chunk):
            state_start = w.start
            state_end = chunk[i + 1].start if i + 1 < len(chunk) else chunk_end
            if state_end <= state_start:
                state_end = state_start + 0.05
            # Build the visible text: first i+1 words
            pieces = []
            for j, ww in enumerate(chunk[: i + 1]):
                txt = ww.text.upper().strip()
                # Escape braces
                txt = txt.replace("{", "").replace("}", "")
                if j == key_idx:
                    # accent color inline: primary colour override
                    pieces.append(r"{\c&H17E5FC&}" + txt + r"{\c&HFFFFFF&}")
                else:
                    pieces.append(txt)
            text = " ".join(pieces)
            # Pop animation only on the newest word: wrap everything with a
            # transform on the last addition. We do it by applying a
            # scale-bounce \t tag at event start.
            # move position is centered via Alignment=5 (middle-center).
            # Bounce: scale 130->100 over 120ms
            anim = r"{\fscx130\fscy130\t(0,120,\fscx100\fscy100)}"
            line = (
                f"Dialogue: 0,{fmt_time(state_start)},{fmt_time(state_end)},"
                f"Main,,0,0,0,,{anim}{text}"
            )
            events.append(line)
    return ass_header(style_block) + "\n".join(events) + "\n"


# -------- style 2: Karaoke highlight --------
# PT Sans Bold, rounded vibe, per-word fill sweep using \k and custom coloring.
def build_karaoke(words: List[Word]) -> str:
    style_block = (
        "Style: Main,PT Sans,98,&H00FFFFFF,&H000000FF,&H00202020,&H96000000,"
        "1,0,0,0,100,100,1,0,1,4,3,2,60,60,260,1"
    )
    events: List[str] = []
    chunks = chunk_words(words, max_words=5, max_chars=28)
    for chunk in chunks:
        chunk_start = chunk[0].start
        chunk_end = chunk[-1].end + 0.20
        # Build one dialogue per word-transition so current word is accent.
        for i, w in enumerate(chunk):
            state_start = w.start
            state_end = chunk[i + 1].start if i + 1 < len(chunk) else chunk_end
            if state_end <= state_start:
                state_end = state_start + 0.05
            pieces = []
            for j, ww in enumerate(chunk):
                txt = ww.text.strip().replace("{", "").replace("}", "")
                if j == i:
                    # current word: bright cyan, slight up-scale
                    pieces.append(r"{\c&HFCE517&\fscx108\fscy108}" + txt + r"{\c&HFFFFFF&\fscx100\fscy100}")
                elif j < i:
                    # already spoken: dim
                    pieces.append(r"{\alpha&H40&}" + txt + r"{\alpha&H00&}")
                else:
                    pieces.append(txt)
            text = " ".join(pieces)
            fade = r"{\fad(80,80)}" if i == 0 else ""
            line = (
                f"Dialogue: 0,{fmt_time(state_start)},{fmt_time(state_end)},"
                f"Main,,0,0,0,,{fade}{text}"
            )
            events.append(line)
    return ass_header(style_block) + "\n".join(events) + "\n"


# -------- style 3: Minimal editorial --------
# Helvetica Neue thin-ish, lowercase, soft shadow, gentle fades, lower-third.
def build_minimal(words: List[Word]) -> str:
    style_block = (
        "Style: Main,Helvetica Neue,72,&H00F2F2F2,&H000000FF,&H00101010,&H78000000,"
        "0,0,0,0,100,100,0,0,1,0,6,2,80,80,220,1"
    )
    events: List[str] = []
    chunks = chunk_words(words, max_words=7, max_chars=34)
    for chunk in chunks:
        start = chunk[0].start
        end = chunk[-1].end + 0.25
        text = " ".join(w.text.strip() for w in chunk).lower()
        text = text.replace("{", "").replace("}", "")
        anim = r"{\fad(180,180)\blur0.6}"
        events.append(
            f"Dialogue: 0,{fmt_time(start)},{fmt_time(end)},"
            f"Main,,0,0,0,,{anim}{text}"
        )
    return ass_header(style_block) + "\n".join(events) + "\n"


BUILDERS = {
    "hormozi": build_hormozi,
    "karaoke": build_karaoke,
    "minimal": build_minimal,
}


def main():
    if len(sys.argv) < 4:
        print("usage: ass_gen.py <transcript.json> <style> <out.ass>")
        print("styles:", ", ".join(BUILDERS))
        sys.exit(1)
    transcript = Path(sys.argv[1])
    style = sys.argv[2]
    out = Path(sys.argv[3])
    words = load_words(transcript)
    ass = BUILDERS[style](words)
    out.write_text(ass, encoding="utf-8")
    print(f"wrote {out} ({len(words)} words)")


if __name__ == "__main__":
    main()
