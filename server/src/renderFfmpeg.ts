/**
 * Fast ffmpeg-based render pipeline. Burns ASS subtitles onto the
 * normalized source.mp4. ~50x faster than Remotion headless Chrome.
 *
 * The Remotion Player stays for in-browser preview; this replaces
 * @remotion/renderer for the actual MP4 export.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { projectDir, OUT_DIR } from "./paths.js";
import { getProject } from "./projects.js";
import { generateAss } from "./assGen.js";
import type { RenderProgress } from "./render.js";

export const renderProjectFfmpeg = async (
  projectId: string,
  style: string,
  onProgress: (p: RenderProgress) => void,
  opts?: { watermark?: boolean },
): Promise<string> => {
  const project = getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  if (!project.source) throw new Error(`project ${projectId} not ingested`);
  if (!project.transcript)
    throw new Error(`project ${projectId} not transcribed`);

  onProgress({ phase: "start" });

  const dir = projectDir(projectId);
  const sourcePath = resolve(dir, "source.mp4");
  const assPath = resolve(dir, `subs_${style}.ass`);

  // Generate ASS subtitles
  onProgress({ phase: "bundling", percent: 0 });
  const assContent = generateAss(
    project.transcript,
    style as "bold" | "clean" | "focus",
    project.source.circle,
    { watermark: opts?.watermark !== false, overlays: project.overlays },
  );
  writeFileSync(assPath, assContent);
  onProgress({ phase: "bundling", percent: 100 });

  // Output path — use recording date for sortable filenames
  mkdirSync(OUT_DIR, { recursive: true });
  const recDate = project.source.original.createdAt;
  const datePrefix = recDate
    ? new Date(recDate)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", "_")
        .slice(0, 15) // 20260410_120000
    : project.createdAt
        .replace(/[-:]/g, "")
        .replace("T", "_")
        .slice(0, 15);
  const outputPath = resolve(OUT_DIR, `${datePrefix}_${style}.mp4`);

  onProgress({ phase: "rendering", percent: 0 });

  // Get total duration for progress calculation
  const totalDuration = project.source.original.duration;

  // ffmpeg: burn ASS subtitles onto source video
  // ffmpeg filter paths need colons and backslashes escaped
  const escapedAssPath = assPath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
  const args = [
    "-y",
    "-i", sourcePath,
    "-vf", `ass=${escapedAssPath}`,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    outputPath,
  ];

  await new Promise<void>((res, rej) => {
    const proc = spawn("ffmpeg", args);
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
          if (Number.isFinite(ms) && totalDuration > 0) {
            const pct = Math.min(100, Math.round((ms / 1000 / totalDuration) * 100));
            onProgress({ phase: "rendering", percent: pct });
          }
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", rej);
    proc.on("close", (code) => {
      if (code !== 0) {
        rej(new Error(`ffmpeg render exited ${code}: ${stderr.slice(-800)}`));
        return;
      }
      res();
    });
  });

  onProgress({ phase: "done", outputPath });
  return outputPath;
};
