# Changelog

## 0.1.0 — 2026-04-13

Initial working version.

### Core pipeline
- Source normalization: ffprobe → aspect strategy → ffmpeg transcode to 1080x1920/30fps/H.264
- 4 aspect strategies: crop (portrait), blur_fill (square/landscape), telegram_circle, letterbox
- Telegram circle auto-detection via corner pixel analysis
- Transcription: mlx-whisper (Metal GPU, ~6s/60s clip) with faster-whisper CPU fallback
- Render: ffmpeg + ASS subtitles (~1s/13s clip, ~15s/60s clip)

### Caption styles
- **Bold** — karaoke word tracking, Arial Black 72px, yellow active word, white spoken, dim upcoming
- **Clean** — dark pill background, phrase-level fade in/out, Arial 48px
- **Focus** — word-by-word highlight, yellow active word with scale, smooth transitions

### Studio UI
- Remotion Player preview with live style switching
- Transcript editor: click to seek, double-click to edit, low-confidence highlighting
- Manual text overlays: positioned text with timing, color, size, outline
- IG Reels safe zone preview overlay (togglable)
- Keyboard shortcuts: Space, arrows, Shift+arrows, Escape

### Project management
- Inbox watcher: auto-detect new files in `in/`, queue ingest + transcribe
- Batch import & render (one-click full pipeline)
- Server-side job queue (p-queue, runs independently of browser)
- Project archive, delete, rename
- Smart batch: skip already-rendered styles
- Presets: save/load style + watermark settings
- Project filters: all / needs transcript / needs render / rendered

### Output
- Date-based filenames (20260320_143022_bold.mp4) for sort-friendly uploads
- Outputs panel: list, download, delete rendered files
- Open output folder in Finder
- Watermark: "titler.org", togglable, on by default
- LAN access: server binds 0.0.0.0, accessible from phone on local network

### Chunking
- Sentence/punctuation-aware word grouping
- Weak-tail detection: Russian conjunctions/prepositions don't end chunks
- Whisper artifact preprocessing: rejoin split numbers (0 ,8 → 0,8)
- Overlap prevention: deOverlap post-processing on ASS dialogue lines
- Two-pass tiny chunk merging (backward then forward)

### Infrastructure
- pnpm workspace (studio, server, remotion packages)
- Face tracking: OpenCV Haar cascades + 1-Euro filter smoothing
- Screenshot extraction: GET /projects/:id/screenshot?time=N
- SSE events endpoint for real-time browser notifications
