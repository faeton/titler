#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Install it: https://pnpm.io/installation" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install with: brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "==> Installing node dependencies"
  pnpm install
fi

if [ ! -d .venv ]; then
  echo "==> Creating Python venv"
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install --upgrade pip
  pip install mlx-whisper faster-whisper opencv-python-headless numpy
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

mkdir -p in out work logs

# Roll the previous log so `logs/current.log` is always the live one.
if [ -f logs/current.log ]; then
  mv logs/current.log "logs/previous.log"
fi
LOG=logs/current.log

echo "==> Starting server (:7777) + studio (:5173)"
echo "==> Logs: $(pwd)/$LOG  (tail -f logs/current.log)"

# Timestamp each line; keep output on stdout AND in the log file.
# unbuffer-style with awk + fflush so `tail -f` sees lines immediately.
exec pnpm dev 2>&1 | awk '{ "date +%H:%M:%S" | getline ts; close("date +%H:%M:%S"); printf "[%s] %s\n", ts, $0; fflush(); }' | tee "$LOG"
