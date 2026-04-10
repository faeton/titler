import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SCRIPTS_DIR, VENV_PYTHON } from "./paths.js";

// Thin subprocess wrapper over scripts/detect_circle.py.
//
// Returns null if the input isn't a Telegram round video; returns the
// detected padding color and source dimensions if it is. A detection
// failure (missing file, ffmpeg crash) rejects the promise.

export type CircleDetection = {
  padColor: [number, number, number];
  sourceSize: [number, number];
};

export const detectTelegramCircle = (
  inputPath: string,
): Promise<CircleDetection | null> =>
  new Promise((resolvePromise, rejectPromise) => {
    const python = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
    const script = resolve(SCRIPTS_DIR, "detect_circle.py");
    const proc = spawn(python, [script, inputPath]);

    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on("error", rejectPromise);
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(`detect_circle exited ${code}: ${err.slice(-400)}`),
        );
        return;
      }
      try {
        const payload = JSON.parse(out.trim()) as
          | { isCircle: true; padColor: [number, number, number]; size: [number, number] }
          | { isCircle: false; reason?: string };
        if (!payload.isCircle) {
          resolvePromise(null);
          return;
        }
        resolvePromise({
          padColor: payload.padColor,
          sourceSize: payload.size,
        });
      } catch (e) {
        rejectPromise(e as Error);
      }
    });
  });
