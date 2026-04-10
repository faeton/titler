"""
Face tracking for smart crop. Detects faces in a video using OpenCV's
DNN face detector, smooths with a 1-Euro filter, outputs a keyframed
crop timeline as JSON.

usage:
  face_track.py <video> <out.json> [--sample-every N]

Output shape:
  {
    "found": true|false,
    "keyframes": [{ "time": 0.0, "x": 148, "y": 0 }, ...],
    "source_width": 1376,
    "source_height": 1840,
    "crop_width": 1035,
    "crop_height": 1840
  }

Keyframes describe the top-left corner of a 9:16 crop window in source
dimensions. Progress lines go to stderr.
"""

import argparse
import json
import math
import os
import sys
from typing import Optional

import cv2
import numpy as np


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class OneEuroFilter:
    """Simple 1-Euro filter for smooth scalar tracking."""

    def __init__(self, min_cutoff: float = 1.0, beta: float = 0.007,
                 d_cutoff: float = 1.0):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.x_prev: Optional[float] = None
        self.dx_prev: float = 0.0
        self.t_prev: Optional[float] = None

    def __call__(self, t: float, x: float) -> float:
        if self.t_prev is None:
            self.x_prev = x
            self.dx_prev = 0.0
            self.t_prev = t
            return x
        dt = max(t - self.t_prev, 1e-6)
        dx = (x - self.x_prev) / dt  # type: ignore
        alpha_d = self._alpha(dt, self.d_cutoff)
        dx_hat = alpha_d * dx + (1 - alpha_d) * self.dx_prev
        cutoff = self.min_cutoff + self.beta * abs(dx_hat)
        alpha = self._alpha(dt, cutoff)
        x_hat = alpha * x + (1 - alpha) * self.x_prev  # type: ignore
        self.x_prev = x_hat
        self.dx_prev = dx_hat
        self.t_prev = t
        return x_hat

    @staticmethod
    def _alpha(dt: float, cutoff: float) -> float:
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)


def detect_faces_haar(frame_gray: np.ndarray, cascade: cv2.CascadeClassifier):
    """Detect faces using Haar cascades. Returns list of (x, y, w, h)."""
    faces = cascade.detectMultiScale(
        frame_gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(60, 60),
    )
    return faces if len(faces) > 0 else []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("output")
    parser.add_argument("--sample-every", type=int, default=5,
                        help="Sample every N frames (default 5)")
    args = parser.parse_args()

    if not os.path.exists(args.video):
        log(f"file not found: {args.video}")
        return 1

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        log(f"cannot open video: {args.video}")
        return 1

    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Compute crop window for 9:16 from source dims
    target_ratio = 1080 / 1920  # 0.5625
    src_ratio = src_w / src_h

    if src_ratio > target_ratio:
        crop_h = src_h
        crop_w = int(round(src_h * target_ratio))
    else:
        crop_w = src_w
        crop_h = int(round(src_w / target_ratio))

    crop_w = min(crop_w, src_w)
    crop_h = min(crop_h, src_h)
    max_x = src_w - crop_w
    max_y = src_h - crop_h

    log(f"source={src_w}x{src_h} crop={crop_w}x{crop_h} fps={fps:.1f} frames={total_frames}")

    # Load Haar cascade (bundled with OpenCV)
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"  # type: ignore
    cascade = cv2.CascadeClassifier(cascade_path)
    if cascade.empty():
        log(f"failed to load cascade from {cascade_path}")
        return 1

    raw_detections: list[tuple[float, float, float]] = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % args.sample_every == 0:
            t = frame_idx / fps
            # Downscale for faster detection
            scale = 480 / max(frame.shape[0], frame.shape[1])
            small = cv2.resize(frame, None, fx=scale, fy=scale)
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

            faces = detect_faces_haar(gray, cascade)
            if len(faces) > 0:
                # Pick largest face
                best = max(faces, key=lambda f: f[2] * f[3])
                fx, fy, fw, fh = best
                # Scale back to original coords
                cx = (fx + fw / 2) / scale
                cy = (fy + fh / 2) / scale
                raw_detections.append((t, cx, cy))

            if frame_idx % (args.sample_every * 30) == 0:
                pct = frame_idx / max(1, total_frames) * 100
                log(f"  scanning {pct:.0f}% ({len(raw_detections)} faces)")

        frame_idx += 1

    cap.release()

    if not raw_detections:
        log("no faces found")
        result = {
            "found": False,
            "keyframes": [],
            "source_width": src_w,
            "source_height": src_h,
            "crop_width": crop_w,
            "crop_height": crop_h,
        }
        with open(args.output, "w") as f:
            json.dump(result, f, indent=2)
        print("DONE")
        return 0

    log(f"found {len(raw_detections)} face detections, smoothing...")

    filter_x = OneEuroFilter(min_cutoff=0.8, beta=0.01)
    filter_y = OneEuroFilter(min_cutoff=0.8, beta=0.01)

    keyframes: list[dict] = []
    for t, cx, cy in raw_detections:
        crop_x = cx - crop_w / 2
        crop_y = cy - crop_h / 2
        crop_x = max(0, min(crop_x, max_x))
        crop_y = max(0, min(crop_y, max_y))

        sx = filter_x(t, crop_x)
        sy = filter_y(t, crop_y)
        sx = max(0, min(sx, max_x))
        sy = max(0, min(sy, max_y))

        keyframes.append({
            "time": round(t, 3),
            "x": int(round(sx)),
            "y": int(round(sy)),
        })

    log(f"output {len(keyframes)} keyframes")

    result = {
        "found": True,
        "keyframes": keyframes,
        "source_width": src_w,
        "source_height": src_h,
        "crop_width": crop_w,
        "crop_height": crop_h,
    }
    with open(args.output, "w") as f:
        json.dump(result, f, indent=2)
    log(f"wrote {args.output}")
    print("DONE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
