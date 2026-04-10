"""
Detect whether a video is a Telegram-style circular video: a round
video content area inscribed in a square container, with a uniform
padding color (usually white) in the four corners.

usage:
  detect_circle.py <video> [out.json]

Emits JSON to stdout:
  { "isCircle": true, "padColor": [r,g,b], "size": [w,h] }
  { "isCircle": false, "reason": "<string>", ... }

Exit code is always 0 unless the input is missing / ffmpeg fails.
"""

import json
import os
import subprocess
import sys
import tempfile
from typing import Tuple

from PIL import Image


def spread(colors: list[Tuple[int, int, int]]) -> int:
    """Max channel spread across a list of RGB tuples."""
    r = [c[0] for c in colors]
    g = [c[1] for c in colors]
    b = [c[2] for c in colors]
    return max(max(r) - min(r), max(g) - min(g), max(b) - min(b))


def avg_rgb(colors: list[Tuple[int, int, int]]) -> Tuple[float, float, float]:
    n = len(colors)
    return (
        sum(c[0] for c in colors) / n,
        sum(c[1] for c in colors) / n,
        sum(c[2] for c in colors) / n,
    )


def channel_dist(a: Tuple[float, float, float], b: Tuple[int, int, int]) -> float:
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"isCircle": False, "reason": "usage"}))
        return 2

    video = sys.argv[1]
    if not os.path.exists(video):
        print(json.dumps({"isCircle": False, "reason": "missing_file"}))
        return 1

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        frame_path = tmp.name

    try:
        # Sample around 1s in — gives the video time to stabilize if it
        # starts with a fade. Fall back to frame 0 if the video is shorter.
        for ss in ("1", "0.3", "0"):
            rc = subprocess.run(
                [
                    "ffmpeg", "-y", "-ss", ss, "-i", video,
                    "-frames:v", "1", "-update", "1", frame_path,
                ],
                capture_output=True,
            )
            if rc.returncode == 0 and os.path.getsize(frame_path) > 0:
                break
        else:
            print(json.dumps({"isCircle": False, "reason": "ffmpeg_extract_failed"}))
            return 0

        im = Image.open(frame_path).convert("RGB")
        w, h = im.size

        # Must be near-square.
        if abs(w - h) > max(4, int(0.02 * min(w, h))):
            print(json.dumps({"isCircle": False, "reason": "not_square", "size": [w, h]}))
            return 0

        # Sample the 4 corners (inset 1px to dodge codec edge artifacts).
        corners = [
            im.getpixel((1, 1)),
            im.getpixel((w - 2, 1)),
            im.getpixel((1, h - 2)),
            im.getpixel((w - 2, h - 2)),
        ]

        # Corners must be consistent across all 4 — Telegram pads with
        # a single flat color.
        if spread(corners) > 24:
            print(json.dumps({
                "isCircle": False,
                "reason": "corners_not_uniform",
                "corners": corners,
            }))
            return 0

        pad = avg_rgb(corners)
        lum = (pad[0] + pad[1] + pad[2]) / 3
        # Must be near white or near black (the two Telegram theme colors).
        if not (lum > 225 or lum < 25):
            print(json.dumps({
                "isCircle": False,
                "reason": "corner_not_extreme",
                "pad_avg": [int(x) for x in pad],
            }))
            return 0

        # Sample the 4 edge midpoints (points where the inscribed circle
        # touches the square's edges). They must contain actual content,
        # NOT the padding color — otherwise we're looking at a flat
        # square with no circle content.
        edge_points = [
            im.getpixel((w // 2, 1)),
            im.getpixel((w // 2, h - 2)),
            im.getpixel((1, h // 2)),
            im.getpixel((w - 2, h // 2)),
        ]
        avg_edge_dist = sum(channel_dist(pad, p) for p in edge_points) / 4
        if avg_edge_dist < 30:
            print(json.dumps({
                "isCircle": False,
                "reason": "edges_match_pad",
                "avg_edge_dist": round(avg_edge_dist, 1),
                "edges": edge_points,
            }))
            return 0

        print(json.dumps({
            "isCircle": True,
            "padColor": [int(round(x)) for x in pad],
            "size": [w, h],
        }))
        return 0
    finally:
        try:
            os.remove(frame_path)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
