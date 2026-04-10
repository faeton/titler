import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { projectDir } from "./paths.js";
import { probe } from "./ffprobe.js";
import {
  pickStrategy,
  buildVideoFilter,
  isComplexFilter,
  TELEGRAM_CIRCLE_LAYOUT,
} from "./aspect.js";
import { detectTelegramCircle } from "./detectCircle.js";
import { getProject, updateProject } from "./projects.js";
import type {
  AspectStrategy,
  CircleLayout,
  CropMode,
  FaceTrackResult,
  SourceInfo,
} from "./types.js";

// Ingest pipeline: ffprobe the source, pick an aspect strategy,
// transcode to work/<id>/source.mp4 at 1080x1920/30fps/H.264, also
// extract mono 16kHz audio to work/<id>/audio.wav for transcription.
//
// Streams progress lines over onProgress (ffmpeg -progress pipe:1).

export type IngestProgress =
  | { phase: "probe" }
  | { phase: "transcode_video"; outTimeMs: number }
  | { phase: "extract_audio" }
  | { phase: "done"; info: SourceInfo };

export const ingestProject = async (
  projectId: string,
  onProgress: (p: IngestProgress) => void,
  opts?: { cropMode?: CropMode; faceTrack?: FaceTrackResult },
): Promise<SourceInfo> => {
  const project = getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);

  const dir = projectDir(projectId);
  mkdirSync(dir, { recursive: true });

  onProgress({ phase: "probe" });
  const original = await probe(project.originalFile);

  // Telegram-round-video detection takes precedence over the generic
  // ratio-based pickStrategy. Only run it when the source is square-ish
  // — otherwise it's guaranteed to return null and we waste an ffmpeg
  // frame extract.
  const isSquareish =
    Math.abs(original.width - original.height) <=
    Math.max(4, 0.02 * Math.min(original.width, original.height));

  let strategy: AspectStrategy;
  let circle: CircleLayout | undefined;
  if (isSquareish) {
    const tg = await detectTelegramCircle(project.originalFile).catch(
      () => null,
    );
    if (tg) {
      strategy = "telegram_circle";
      circle = TELEGRAM_CIRCLE_LAYOUT;
    } else {
      strategy = pickStrategy(original);
    }
  } else {
    strategy = pickStrategy(original);
  }

  const faceTrack =
    opts?.cropMode === "face_track" ? opts.faceTrack : undefined;
  const vf = buildVideoFilter(strategy, { circle, faceTrack });

  const normalizedPath = resolve(dir, "source.mp4");
  const audioPath = resolve(dir, "audio.wav");

  // ---- video transcode ----
  // With -filter_complex the filter graph uses named output [vout] so we
  // can -map it. With -vf the implicit main video stream is used.
  const complex = isComplexFilter(strategy);
  const vArgs: string[] = [
    "-y",
    "-i",
    project.originalFile,
    ...(complex ? ["-filter_complex", vf] : ["-vf", vf]),
    "-map",
    complex ? "[vout]" : "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    normalizedPath,
  ];

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn("ffmpeg", vArgs);
    let stderr = "";
    let progressBuf = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      progressBuf += chunk.toString();
      let idx: number;
      while ((idx = progressBuf.indexOf("\n")) >= 0) {
        const line = progressBuf.slice(0, idx).trim();
        progressBuf = progressBuf.slice(idx + 1);
        if (line.startsWith("out_time_ms=")) {
          const ms = Number(line.slice("out_time_ms=".length)) / 1000;
          if (Number.isFinite(ms)) {
            onProgress({ phase: "transcode_video", outTimeMs: ms });
          }
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", rejectPromise);
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(`ffmpeg (video) exited ${code}: ${stderr.slice(-800)}`),
        );
        return;
      }
      resolvePromise();
    });
  });

  // ---- audio extract (mono 16kHz PCM for whisper) ----
  onProgress({ phase: "extract_audio" });
  const aArgs = [
    "-y",
    "-i",
    project.originalFile,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    audioPath,
  ];

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn("ffmpeg", aArgs);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", rejectPromise);
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(`ffmpeg (audio) exited ${code}: ${stderr.slice(-800)}`),
        );
        return;
      }
      resolvePromise();
    });
  });

  const info: SourceInfo = {
    original,
    aspectStrategy: strategy,
    normalizedPath,
    audioPath,
    ...(circle ? { circle } : {}),
  };
  updateProject(projectId, {
    source: info,
    ...(opts?.cropMode ? { cropMode: opts.cropMode } : {}),
  });
  onProgress({ phase: "done", info });
  return info;
};
