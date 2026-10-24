import type { Probe } from "@titler/core";
import { run } from "./run.js";

/** Probe plus a few server-only fields (stored alongside; harmless extra JSON for clients). */
export interface ProbeX extends Probe {
  pixFmt: string | null;
  colorTransfer: string | null;
  /** Audio stream duration, if any. */
  audioDurationMs: number | null;
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  color_transfer?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

const isoOrNull = (s: string | null): string | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const rate = (r: string | undefined): number | null => {
  if (!r) return null;
  const [n, d] = r.split("/").map(Number);
  const v = n! / (d || 1);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** Normalise a display rotation to 0/90/180/270 (clockwise display rotation as ffprobe reports, sign dropped). */
const normRot = (deg: number): number => (((Math.round(deg / 90) * 90) % 360) + 360) % 360;

export const parseProbe = (json: { streams?: FfStream[]; format?: { duration?: string; tags?: Record<string, string> } }): ProbeX => {
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("no video stream");
  const fmtTags = json.format?.tags ?? {};
  const vTags = v.tags ?? {};
  const sideRot = v.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation;
  const rotation = normRot(sideRot ?? Number(vTags.rotate ?? 0));
  const w = Number(v.width ?? 0);
  const h = Number(v.height ?? 0);
  const swap = rotation === 90 || rotation === 270;
  const tag = (k: string) => fmtTags[k] ?? vTags[k];
  // Meta glasses / iPhone: creationdate = when it was shot; creation_time = export/sync time.
  const createdAt = tag("com.apple.quicktime.creationdate") ?? tag("creation_time") ?? null;
  const make = tag("com.apple.quicktime.make") ?? tag("make") ?? null;
  const model = tag("com.apple.quicktime.model") ?? tag("model") ?? null;
  const device = [make, model].filter(Boolean).join(" ").trim() || null;
  const durS = Number(json.format?.duration ?? v.duration ?? 0);
  return {
    width: swap ? h : w,
    height: swap ? w : h,
    rotation,
    fps: rate(v.r_frame_rate) ?? rate(v.avg_frame_rate) ?? 30,
    durationMs: Math.round(durS * 1000),
    videoCodec: v.codec_name ?? "unknown",
    audioCodec: a?.codec_name ?? null,
    sampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
    channels: a?.channels ?? null,
    createdAt: isoOrNull(createdAt),
    device,
    pixFmt: v.pix_fmt ?? null,
    colorTransfer: v.color_transfer ?? null,
    audioDurationMs: a?.duration ? Math.round(Number(a.duration) * 1000) : null,
  };
};

export const ffprobeJson = async (ffprobe: string, path: string): Promise<Record<string, unknown>> => {
  const { stdout } = await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
  return JSON.parse(stdout) as Record<string, unknown>;
};

export const probeFile = async (ffprobe: string, path: string): Promise<ProbeX> =>
  parseProbe((await ffprobeJson(ffprobe, path)) as Parameters<typeof parseProbe>[0]);
