# Titler — face anonymisation (blur, pixelate, box, eye bar, sticker)

2026-10-27. Part of the next stage ([PLAN-v4.md](PLAN-v4.md), stages F1/F2/F3).
Context: [spec-workflow.md](spec-workflow.md) (framing, export checks), [PLAN-v3.md](PLAN-v3.md) (series, covers),
render graph in `apps/server/src/media/commands.ts` (`framingGraph`, `renderArgs`, `coverArgs`).

## Why

POV footage from the glasses is full of bystanders: people in the street, at a counter, across a
table. Publishing them unblurred is a privacy and sometimes a legal problem, and doing it by hand
in another editor breaks the main metric (manual work between upload and publication). The owner's
own face is rarely in frame; other people's faces are the norm, often small, in profile, moving and
motion-blurred.

What the user wants to say:
- "blur every face" (default when the feature is on);
- "blur everyone except this person" (a friend who agreed, a guest in a dialogue);
- "blur only this person" (one bystander in an otherwise fine shot);
- and pick how: blur, pixelate, solid box, eye bar, sticker.

Not goals: blurring arbitrary objects in F1/F2 (licence plates, screens and documents come in F3
through the same mask pipeline); identifying who people are; any cloud processing of faces.

## Principles

1. **Missing a face is worse than blurring a bit of wall.** Low detection threshold, generous
   padding, track bridging and hold after loss. Recall is the metric; precision is fixed by the user
   with one tap.
2. **Fail closed.** If anonymisation is on and the face data is missing, stale or failed, the render,
   the cover and (S4) publishing refuse. Never a silent unblurred export.
3. **Source coordinates, framing-independent.** Detections live in normalised source coordinates,
   like `CropKeyframe`. Changing the crop doesn't re-run detection.
4. **Preview == render**, as with captions: the same core functions decide which boxes are active
   at time *t*, with which padding and shape.
5. **Strong enough to be irreversible.** Light Gaussian blur on a face can be partly undone and
   still allows recognition. Blur and pixelate presets start strong, with the user able to go stronger,
   not weaker than a floor.
6. **Local only.** Faces are processed on n5 or the Mac, never sent to a cloud provider
   (`dataLeavesBox: false` always for this step).

## 1. Detection: a new worker role `faces`

`python -m titler_worker --role faces` (add to `ROLES` in `workers/titler_worker/__main__.py`).

**Input:** the **source** (not the 720 px proxy: small faces need resolution), decoded by ffmpeg to
raw frames at a 1280 px long side, sampled at ~10 fps (configurable 5–15). For a 64 s clip that is
~640 frames.

**Detector candidates** (pick by measured recall on our own clips, see §7):

| detector | where | notes |
|---|---|---|
| Apple Vision `VNDetectFaceRectanglesRequest` (+ landmarks request) | Mac | OS framework via `pyobjc-framework-Vision`, runs on the Neural Engine, good with profiles; no weights to ship |
| YuNet (OpenCV zoo, ONNX) | both | tiny (~300 KB), MIT, fast on CPU, 5 landmarks; weaker on small and profile faces; run at higher input size |
| SCRFD 2.5G / 10G (insightface, ONNX) | both | best small-face recall of the three, 5 landmarks; **weights are licensed for non-commercial research**: fine for the owner's own use, must be swapped before Titler is offered to anyone else |
| RetinaFace (ResNet50, ONNX) | both | strong recall, slower; fallback if SCRFD's licence becomes a blocker |

Runtime: `onnxruntime` CPU on n5 (the Radeon 890M via ROCm/MIGraphX is a separate experiment; see
PLAN-v4 housekeeping), CoreML execution provider or Vision on the Mac. New venv `faces`
(`onnxruntime`, `opencv-python-headless`, `numpy`; on the Mac also `pyobjc-framework-Vision`), set up
by `deploy/n5` and `deploy/mac/setup.sh`, with a capability probe so a missing venv disables the
step with a reason instead of breaking the other one (as for mlx-whisper).

**Tracking** (pure Python, no extra deps):
- IoU + centre-distance association (ByteTrack-style: high-score detections first, then low-score
  ones to extend existing tracks), with a constant-velocity Kalman filter per track.
- Bridge gaps up to ~0.6 s by prediction; keep blurring a lost track for ~0.3 s (`holdMs`).
- Interpolate boxes between samples, so the render can ask for any time.
- Drop tracks shorter than ~3 samples **only if** every score is low (a short high-score track is a
  real face passing by).
- Per track: a few thumbnails (largest, sharpest box) for the UI.

**Later (F2): people instead of tracks.** ArcFace-style embeddings per track (a small ONNX model,
e.g. MobileFaceNet) → agglomerative clustering → `personId`. One person who leaves and comes back is
one toggle, not five. The user can merge and split groups by hand.

**Output artifact** `faces` (JSON, key = source + detector + model version + fps + thresholds):

```ts
interface FaceTrack {
  id: string;            // stable within the artifact
  personId?: string;     // F2
  spans: [Ms, Ms][];     // when the track is active
  boxes: { t: Ms; x: number; y: number; w: number; h: number; score: number; lm?: number[] }[]; // normalised source coords
  thumbs: string[];      // artifact-relative JPEGs
}
interface FacesResult { detector: string; fps: number; tracks: FaceTrack[]; lowConfidence: Ms[] }
```

`lowConfidence` lists times worth a human look (gaps bridged by prediction, scores near the threshold,
heavy motion). Review mode (§4) walks through them.

Cost estimate: YuNet or SCRFD-2.5G at 1280 px on n5's CPU ≈ 15–40 ms/frame → 10–25 s for a 64 s
clip; Vision on the Mac faster. The step runs after ingest in the background, like analyze, but only
when the project has anonymisation on (or the user taps "Find faces"), so clips without people
don't pay for it.

## 2. Settings (core types)

In `packages/core/src/types.ts`, next to `series` and `cover`:

```ts
type FaceStyle = "blur" | "pixelate" | "box" | "eyebar" | "sticker";

interface Privacy {
  mode: "off" | "all" | "only" | "except";
  /** Track ids (F1) or person ids (F2) for "only" / "except". */
  targets: string[];
  style: FaceStyle;
  strength: number;          // 0..1 on top of a floor that keeps it irreversible
  padding: number;           // box growth, fraction of face size (default 0.35)
  shape: "ellipse" | "rect";
  boxColor?: string;         // style "box"
  sticker?: string;          // style "sticker": built-in emoji set id
  /** Manual fixes. */
  added: { id: string; keys: { t: Ms; x: number; y: number; w: number; h: number }[] }[]; // missed faces, keyframed
  ignored: string[];         // false-positive track ids
}
export const DEFAULT_PRIVACY: Privacy = { mode: "off", targets: [], style: "blur", strength: 0.5, padding: 0.35, shape: "ellipse", added: [], ignored: [] };
```

Old projects get the default (`off`), so nothing changes until the user turns it on.
`activeBoxes(faces, privacy, t)` in core is the single source of truth for which boxes are drawn at
time *t* (mode, targets, ignored, added, padding, hold), used by the preview, the mask writer
(through a JSON plan handed to the worker) and the cover.

## 3. Rendering: a mask video and `maskedmerge`

Per-frame moving boxes don't fit ffmpeg's static filters, and `sendcmd` scripts with many tracks are
fragile. Instead the worker renders the active boxes into a **mask video**, and the render graph
uses it as an extra input.

**Mask artifact** (key = faces artifact + the mask-relevant privacy fields: mode, targets, padding,
shape, added, ignored):
- grayscale, source aspect at a 1280 px long side, CFR 30 fps, lossless (`ffv1` in MKV); feathered
  edges (~6 % of the box) so the effect blends in;
- times line up with the source (the same t0 as the source's first video frame);
- size is small (mostly black frames compress to almost nothing).

**Graph** (inserted between framing and captions, so captions stay sharp and on top):

```
[0:v] framing → [base]
[2:v] same framing chain (crop / scale / pad, black pad) → [mask]
[base] split [a][b]
[b] <effect> [fx]
[a][fx][mask] maskedmerge [anon]
[anon] → ass → encoder           (captioned)
[anon] → encoder                 (clean)
```

- Passing the mask through **the same crop/scale chain** as the picture means framing, keyframes and
  fit modes stay correct with no geometry code of our own. `framingGraph` takes the input label as a
  parameter; for the mask the `fit_blur` background branch is replaced by a black pad.
- The mask input gets the same `-ss` as the source and the processed audio, so **series parts work
  unchanged**.
- `<effect>` per style:
  - **blur**: `scale=iw/8:ih/8,gblur=sigma=S,scale=W:H`: blurring a downscaled copy is both
    stronger and ~50× cheaper than `gblur` at 1080×1920.
  - **pixelate**: `scale=iw/N:ih/N:flags=area,scale=W:H:flags=neighbor` (N from strength, ≥ 16
    blocks across a typical face).
  - **box**: a `color` source instead of `[fx]`.
- **eyebar** and **sticker** don't fit a mask: the worker renders a small RGBA overlay video (qtrle
  or PNG in MOV) at the output size and the graph adds `overlay` after `[anon]`. Eye bars come from
  the 5 landmarks; stickers are a built-in emoji set drawn at the box. Since the overlay is in output
  coordinates, it's rendered per framing (key includes framing + output size).
- The VAAPI and VideoToolbox paths already download frames to the CPU for crop/scale/libass, so
  `maskedmerge` adds no hw/sw transfer. `commands.test.ts` gets cases for all three encoder kinds.

**Covers:** `coverArgs` gets the same chain with the mask seeked to `atMs`. A cover is a published
image, so this is required, not optional; a cover job with privacy on and no mask fails.

**Validation** (like series parts): for a few sampled times with active boxes, compare a sharpness
measure (Laplacian variance) inside the box between the clean framing and the anonymised output;
the anonymised one must drop below a threshold. The e2e script gets `--faces <style>`.

## 4. Preview and UI

**Stage overlay** (`apps/web/src/player/`, next to `CaptionOverlay`): for the current time,
`activeBoxes()` → absolutely positioned elements mapped through the same framing transform the stage
already uses:
- blur: `backdrop-filter: blur()` (with `-webkit-` for iOS Safari) on an ellipse/rect element;
- pixelate: a small canvas reading the video frame, drawn with `imageSmoothingEnabled = false`;
- box / eyebar / sticker: plain elements.
Live, no re-render, so style and strength changes feel instant.

**«Лица» (Faces) panel** (a section on the Frame tab):
- off / all / only / except, style picker, strength, padding, shape;
- a strip of tracks (F1) or people (F2): thumbnail, total time on screen, toggle;
- the timeline shows face spans under the playhead so the user sees where people appear;
- tap a box on the stage → "not a face" (adds to `ignored`) or "this person: keep visible";
- "Add box" on the stage → drag a box, then adjust it on two or more frames (keyframes, interpolated)
  for a missed face;
- **Review** walks through `lowConfidence` times, paused, with ‹ › to step. Shows a banner until
  reviewed once: "Automatic detection misses faces. Review N spots before publishing."

The Export screen shows the privacy state in its summary (and S4's pre-send screen too):
"Faces: blurred (all), reviewed" or "Faces: off".

## 5. Server

- Job `faces` (analysis) and job `face_mask` (render input), each an artifact with progress, cached
  by key, like proxy and frame scan.
- `GET /api/projects/:id/faces` → `FacesResult` (thumbnails as artifact URLs).
- `POST /api/projects/:id/faces { fps?, detector? }` to (re)run detection.
- Render and cover jobs resolve the mask first; settings PATCH doesn't invalidate the faces artifact,
  only the mask (and overlay).
- `/api/providers` gets a `faces` step with the available detectors and `dataLeavesBox: false`.

## 6. Phases

| # | scope | done when |
|---|---|---|
| F1 | `faces` role (Vision on Mac, YuNet + SCRFD on n5), tracker, `faces` artifact; `Privacy` with `all`/`off`; blur + pixelate + box via mask in render, series parts and covers; stage preview; ignore a false positive; fail-closed checks | e2e `--faces blur` passes on both runtimes; recall ≥ 95 % of labelled faces on the test set (§7); render time +≤ 30 % at 9:16 |
| F2 | people (embeddings + clustering, merge/split), `only`/`except`, manual keyframed boxes, review mode, eye bar and sticker overlays | "everyone except me" works across a clip where the person leaves and returns; a missed face can be fixed in < 30 s on the phone |
| F3 | background blur instead of faces (keep one person sharp: person segmentation, e.g. MediaPipe selfie / RVM); licence plates and screens (a YOLO plate detector) through the same mask pipeline | per detector, same validation as F1 |

## 7. Test set and measurements

- A small labelled set from real glasses clips: street, café, transport, a dialogue across a table,
  low light, fast head turns. Labels: a box every ~0.5 s per visible face, plus "too small to matter"
  flags. Stored gitignored in `bench/refs/faces/` (**the repo is public: no real faces, frames or
  thumbnails are ever committed**; unit tests use synthetic boxes, e2e uses `bench/samples`).
- `bench/faces/score.py`: per-detector recall/precision at the frame level and at the track level
  ("fraction of time each labelled face was covered"), plus ms/frame. Report in
  `bench/REPORT-faces.md`, like the other `REPORT-*`.
- The detector default per runtime is chosen from that report, not from this plan.

## My decisions (review)

- Default style **blur**, strong; default shape ellipse, padding 35 %.
- Detection at ~10 fps on a 1280 px decode, not on the proxy and not at full frame rate.
- Mask video instead of `sendcmd` or ASS drawing: one generic mechanism for every mask-based style,
  framing for free, series for free.
- Blur applied after framing (output resolution), not on the full-resolution source: cheaper, and
  the result is the same for what is published.
- SCRFD is acceptable for the owner's own use; the licence is recorded here so it isn't forgotten if
  Titler is ever offered to others.
- Faces never leave the machine; no cloud provider for this step.
