import { spawn } from "node:child_process";
import type { ProbeInfo } from "./types.js";

// Run ffprobe and parse ProbeInfo including metadata (creation_time,
// device model, etc.) for the sidebar display.

export const probe = (inputPath: string): Promise<ProbeInfo> =>
  new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,codec_name:format=duration:format_tags=creation_time,com.apple.quicktime.model,com.apple.quicktime.software,com.apple.quicktime.make",
      "-of",
      "json",
      inputPath,
    ];
    const proc = spawn("ffprobe", args);
    let out = "";
    let err = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    proc.on("error", rejectPromise);
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`ffprobe exited ${code}: ${err}`));
        return;
      }
      try {
        const parsed = JSON.parse(out);
        const stream = parsed.streams?.[0];
        const format = parsed.format;
        if (!stream || !format) {
          rejectPromise(new Error(`ffprobe: no video stream in ${inputPath}`));
          return;
        }
        const [num, den] = (stream.r_frame_rate as string).split("/");
        const fps = Number(num) / Number(den || "1");
        const tags = format.tags ?? {};
        resolvePromise({
          width: Number(stream.width),
          height: Number(stream.height),
          fps: Number.isFinite(fps) ? fps : 30,
          codec: String(stream.codec_name ?? "unknown"),
          duration: Number(format.duration ?? 0),
          createdAt: tags.creation_time ?? null,
          device: tags["com.apple.quicktime.model"] ?? null,
          make: tags["com.apple.quicktime.make"] ?? null,
          software: tags["com.apple.quicktime.software"] ?? null,
        });
      } catch (e) {
        rejectPromise(e as Error);
      }
    });
  });
