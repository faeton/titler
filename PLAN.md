# titler — local studio plan

Turn the existing CLI pipeline (`transcribe.py` + `pillow_render.py`) into a
local-first browser studio for authoring and batch-processing subtitled reels.
Public/server deployment is a non-goal for v1 — the existing stub
(`api/server.js`) stays as-is and becomes the eventual deployment target, but
the primary target is `http://localhost` on the laptop.

## Guiding principles

- **Local first.** The laptop is the runtime. Browser UI is just a thin client
  over a local HTTP server that shells out to the existing Python scripts.
- **Reuse, don't rewrite.** `transcribe.py` and `pillow_render.py` already do
  the hard parts (Whisper word-level timings, three styles, frame-accurate
  overlay compositing). New code orchestrates; it does not re-implement.
- **Presets are the UX.** The default flow is "bulk process ten videos with my
  usual settings". Every interactive knob must be serializable to a preset.
- **Phone → laptop transfer is out of scope for v1.** Treat it as "drop files
  in an inbox folder". Anything fancier (AirDrop hot folder, iOS Shortcut,
  QR upload) is a follow-up.

## Architecture

```
┌──────────────────────────────┐    HTTP/WS     ┌────────────────────────┐
│  browser UI (studio/)        │ ◄────────────► │  local server          │
│  - Vite + React + TS         │   localhost    │  (FastAPI, Python)     │
│  - video player + timeline   │                │  - wraps transcribe.py │
│  - subtitle editor           │                │  - wraps pillow_render │
│  - crop / frame picker       │                │  - job queue + presets │
│  - batch queue view          │                │  - inbox watcher       │
└──────────────────────────────┘                └──────────┬─────────────┘
                                                           │ subprocess
                                                  ┌────────▼─────────┐
                                                  │  existing python │
                                                  │  transcribe.py   │
                                                  │  pillow_render.py│
                                                  └──────────────────┘
```

Why FastAPI instead of extending `api/server.js`:
- The workers are already Python; keeping one language avoids a JS↔Python
  process boundary.
- `api/server.js` is the eventual *public* API surface (auth, rate limits,
  shaped for deployment). The local studio is a different concern — separate
  process, no auth, bound to `127.0.0.1`.
- When we ship publicly, the FastAPI layer can be ported to Node (or the Node
  stub can call the same Python scripts). v1 doesn't need to decide.

New layout:

```
titler/
├── api/               # untouched — future public deployment
├── studio/            # NEW — vite+react frontend
│   ├── src/
│   └── package.json
├── server/            # NEW — local fastapi app
│   ├── main.py        # routes
│   ├── jobs.py        # queue + subprocess orchestration
│   ├── presets.py     # read/write presets
│   ├── crop.py        # face tracking + crop preview
│   └── inbox.py       # watch a folder for phone drops
├── transcribe.py      # reused as-is
├── pillow_render.py   # extended (crop support, see milestone 3)
├── work/              # existing scratch dir
├── out/               # existing final outputs
└── inbox/             # NEW — phone-drop hot folder
```

## Milestones

### M1 — local server + subtitle editor (the core loop)

Deliverable: open a video in the browser, see the word-level transcript on a
timeline, click a word to seek + play that 1-second window, edit the text,
re-render with the chosen style.

- `server/main.py` — FastAPI app on `127.0.0.1:7777`. No auth.
- `POST /projects` — upload a video (or reference a path); creates a project
  dir under `work/<project_id>/`.
- `POST /projects/:id/transcribe` — wraps `transcribe.py`, streams progress
  over SSE/WebSocket.
- `GET /projects/:id/transcript` — returns the JSON `transcribe.py` already
  emits.
- `PATCH /projects/:id/transcript` — write edits back to
  `work/<id>/transcript.json`. Edits are just text + (optional) retimed
  start/end.
- `POST /projects/:id/render` — wraps `pillow_render.py` with a style + crop
  config, streams progress.
- `GET /projects/:id/preview/<second>.jpg` — single-frame extract via ffmpeg
  (cached). Used by the frame picker in M3.
- Static serve `studio/dist` at `/` so the app is one URL.

Frontend (`studio/`):
- React + TypeScript + Vite. No router needed for v1 (single project view).
- Video player (HTML5 `<video>`) wired to a transcript timeline.
- Clicking a word → `video.currentTime = word.start; video.play()`, pause at
  `word.end`. This is the "audio preview per unclear word" requirement from
  the brain dump — it falls out for free because we already have word-level
  timings from Whisper.
- Editable text per word (contenteditable or input). Save on blur → PATCH.
- Style picker: hormozi / karaoke / minimal (already in `pillow_render.py`).
- "Render" button → job, progress bar, preview the output.

### M2 — screenshot + text overlay authoring

Deliverable: pause on any frame, grab a screenshot, draw text on top, save it
as an overlay that composites into the final render.

- `POST /projects/:id/screenshot` — `{ time: float }` → returns a PNG from
  the base video (ffmpeg `-ss <t> -frames:v 1`).
- Browser canvas editor: add text blocks (font, size, color, position,
  duration window).
- Persist overlays as `work/<id>/overlays.json`:
  ```json
  [{ "start": 2.1, "end": 4.0, "text": "...", "x": 540, "y": 1200, ... }]
  ```
- Extend `pillow_render.py` with a `render_manual_overlays(overlays, ...)`
  pass that runs **after** the style pass and before composite. Same
  `State` / cache-by-key machinery already in the file — no new rendering
  engine needed.

### M3 — crop + face tracking preview

Deliverable: pick any frame (or a few), drag a crop rectangle, optionally
enable face tracking; see how the crop lands across the video before
committing.

- `server/crop.py`:
  - Static crop: just store `{ x, y, w, h }` per project.
  - Face tracking: MediaPipe Face Detection (CPU, already fast on M-series).
    Sample every N frames, smooth with a 1€ filter, export a keyframed crop
    timeline to `work/<id>/crop.json`.
  - Toggle in the UI: `crop_mode: "none" | "static" | "face_track"`.
- `GET /projects/:id/preview/<second>.jpg?crop=1` — applies the current crop
  to a single frame server-side so the UI can show "what will the final
  look like at t=12.5s".
- Frame picker: pick up to ~6 seconds across the video, show a grid of
  cropped previews. This is the "вырезать любой фрейм или несколько фреймов
  и посмотреть, как кроп ляжет" requirement.
- `pillow_render.py` extension: before compositing, add an ffmpeg crop/scale
  stage (static) or a `crop` filter driven by the keyframed timeline (face
  track). Overlay is already rendered at 1080×1920, so if the crop output is
  also 1080×1920 nothing else changes.

### M4 — presets + batch processing

Deliverable: drop 10 videos into `inbox/`, pick a preset, hit "process all",
walk away.

- `server/presets.py` — CRUD over `presets/*.json`. A preset bundles:
  ```json
  {
    "name": "default reels",
    "style": "hormozi",
    "chunk": { "max_words": 4, "max_chars": 22, "max_gap": 0.6 },
    "crop_mode": "face_track",
    "overlays": []
  }
  ```
- `server/jobs.py` — simple in-process queue (asyncio). One job per video.
  Progress streamed to any connected browser over WebSocket.
- Batch view in the UI: list of files from `inbox/`, checkbox grid, preset
  selector, "process selected" button.
- Save-from-project: "save current settings as preset" so the interactive
  path feeds the batch path.

### M5 — inbox / phone drop

Deliverable: drop a file in `~/titler-inbox/` (or the project `inbox/`) and
it shows up in the studio without a refresh.

- `server/inbox.py` — `watchdog` on the inbox folder. On new file, fingerprint
  (size + mtime) to ignore partial copies, move into `work/<new_id>/`, emit
  a WS event.
- Phone → laptop transfer in v1 is just: AirDrop → Finder → drag to
  `~/titler-inbox`. No custom transport.

## Open questions (TODO, not v1)

- **Native mobile?** The brain dump asks whether this could run entirely on
  the phone without a server. Worth a spike:
  - Whisper: `whisper.cpp` has iOS builds; `faster-whisper` does not.
    Realistic on a recent iPhone for short clips.
  - Rendering: Pillow has no iOS story. Would need to port the state
    machine / font logic to Core Graphics or a WebGPU canvas. Non-trivial.
  - Crop + face: Vision framework handles face detection natively.
  - Verdict to investigate, not commit to: a PWA that does transcription
    server-side but all editing client-side is probably the realistic
    middle ground. Pure-on-device is a months-long detour.
- **Overlay timing UX.** Editing subtitle start/end by hand is tedious. A
  draggable timeline handle per word is probably what we want in M1, not
  a number input. Decide once M1 is walkable.
- **Multi-video preset application.** Face tracking crops are inherently
  per-video (faces are in different places). Presets need to say "detect
  faces per video" vs "apply this exact rect to all". Clarify in M4.
- **Public deployment.** `api/server.js` stays stubbed until someone actually
  asks. When we do ship, the call shape from `studio/` to the local server
  is the same shape we'd want from a deployed backend — design the routes
  with that in mind now, not later.

## Not doing (explicitly)

- Rewriting `pillow_render.py` in JS/WebGPU.
- A database. Projects and presets live on disk as JSON; filesystem is the
  source of truth. Revisit only if we hit real pain.
- User accounts, auth, multi-tenant anything. It's a single-user local tool.
- Cloud storage. Files live in `work/` and `out/`.
- Keeping `ass_gen.py` — it's already superseded by `pillow_render.py` and
  should probably be deleted in a cleanup pass during M1.
