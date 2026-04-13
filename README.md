# titler

Local-first video captioning studio for Instagram Reels and Stories. Drop short-form videos from your phone (Ray-Ban Meta Smart Glasses, Telegram circles, iPhone), transcribe with Whisper, pick a caption style, batch-render with ffmpeg.

## Stack

- **Studio** — Vite + React + TypeScript, Remotion Player for preview
- **Server** — Fastify + TypeScript, ffmpeg for render, p-queue job system
- **Transcription** — mlx-whisper (Apple Silicon GPU) or faster-whisper (CPU fallback)
- **Render** — ffmpeg + ASS subtitles (~1s per 13s clip on M3 Max)

## Features

- 4 aspect strategies: crop, blur-fill, telegram circle, letterbox
- 3 caption styles: Bold (karaoke word tracking), Clean (dark pill), Focus (word-by-word highlight)
- Transcript editor with word-level seek and inline edit
- Manual text overlays with position/timing/color controls
- Face tracking (OpenCV Haar cascades) with crop mode toggle
- Server-side job queue — close the browser, processing continues
- Inbox watcher — drop a file in `in/`, auto-ingest + transcribe
- Batch import & render with one click
- Presets (save/load style settings)
- Watermark (togglable)
- LAN access — grab rendered files from your phone
- IG Reels safe zone preview overlay
- Keyboard shortcuts: Space play/pause, arrows seek, Shift+arrows ±5s

## Setup

```bash
# Prerequisites: Node 20+, pnpm, Python 3.10+, ffmpeg (with libass)
# On macOS: brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg

# Install dependencies
pnpm install

# Python venv (for transcription + face tracking)
python3 -m venv .venv
source .venv/bin/activate
pip install mlx-whisper faster-whisper opencv-python-headless numpy

# Start
pnpm dev  # starts server (:7777) + studio (:5173)
```

## Usage

1. Drop video files into `in/`
2. Open http://localhost:5173
3. Select inbox files → "import & render"
4. Or: import → edit transcript → pick style → render
5. Grab MP4s from the outputs panel or `out/` folder

## Project structure

```
titler/
├── studio/          # React frontend (Vite)
├── server/          # Fastify backend
├── remotion/        # Remotion compositions (preview)
├── scripts/         # Python helpers (transcribe, face_track, detect_circle)
├── presets/         # Saved style presets
├── in/              # Inbox (drop videos here)
├── work/            # Per-project working directories
└── out/             # Rendered MP4 outputs
```

## License

Private.
