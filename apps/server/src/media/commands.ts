import type { Framing, Probe } from "@titler/core";

// Pure ffmpeg argument builders (unit-tested). Paths are passed in absolute.
// VAAPI recipe (n5): bench/REPORT-gpu.md §4 — VAAPI decode, CPU crop/scale/libass,
// hwupload, h264_vaapi CQP. We let ffmpeg download decoded frames itself (no
// -hwaccel_output_format vaapi) so the CPU autorotate filter still applies and
// the output carries no display-matrix side data. scale_vaapi is broken on
// this iGPU, so all scaling is on the CPU.
// VideoToolbox (macOS): CPU decode, CPU filters, nv12 frames to h264_videotoolbox
// (no hwupload — VT takes system-memory frames). No VT decode: on M3 Max, VT HEVC
// decode + frame download is 3.5× slower than CPU decode (10.2 s vs 2.9 s, 64 s clip).
// -q:v 65 ≈ libx264 crf 18 (VMAF 99.43 vs 99.45, 17 vs 20 Mbps) in half the time.

export type EncoderKind = "vaapi" | "videotoolbox" | "software";

export interface Encoder {
  kind: EncoderKind;
  vaapiDevice: string;
}

export const encoderName = (kind: EncoderKind): string =>
  kind === "vaapi" ? "h264_vaapi" : kind === "videotoolbox" ? "h264_videotoolbox" : "libx264";

export const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Fit (w,h) so the long side is at most `max`, keeping aspect; even dims. */
export const fitLong = (w: number, h: number, max: number): { w: number; h: number } => {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: even(w * s), h: even(h * s) };
};

const hwInput = (enc: Encoder): string[] =>
  enc.kind === "vaapi"
    ? ["-init_hw_device", `vaapi=va:${enc.vaapiDevice}`, "-filter_hw_device", "va", "-hwaccel", "vaapi", "-hwaccel_device", "va"]
    : [];

/** Video filter tail that hands frames to the encoder. */
const encTail = (enc: Encoder): string =>
  enc.kind === "vaapi" ? "format=nv12,hwupload" : enc.kind === "videotoolbox" ? "format=nv12" : "format=yuv420p";

// The proxy is streamed to a phone over the tailnet, often via a relay: keep it
// small (~2 Mbps, 720p) with a 1 s GOP so seeks and word taps start quickly.
const PROXY_RATE = ["-b:v", "1800k", "-maxrate", "2500k", "-bufsize", "4M", "-g", "30"];

// VT on Apple Silicon: -q:v is constant quality (1–100); -allow_sw 0 so a missing
// hardware session fails loudly (→ libx264 fallback) instead of a slow software VT.
const VT = ["-c:v", "h264_videotoolbox", "-allow_sw", "0", "-profile:v", "high"];

const videoCodec = (enc: Encoder, quality: "proxy" | "final"): string[] => {
  if (enc.kind === "vaapi")
    return quality === "proxy"
      ? ["-c:v", "h264_vaapi", "-rc_mode", "VBR", ...PROXY_RATE, "-profile:v", "high"]
      : ["-c:v", "h264_vaapi", "-rc_mode", "CQP", "-qp", "21", "-profile:v", "high"];
  if (enc.kind === "videotoolbox") return quality === "proxy" ? [...VT, ...PROXY_RATE] : [...VT, "-q:v", "65"];
  return quality === "proxy"
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", ...PROXY_RATE, "-profile:v", "high", "-pix_fmt", "yuv420p"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p"];
};

const common = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"];

/** Quote a path for use inside a filtergraph option value. */
export const filterPath = (p: string): string => {
  if (/['\n]/.test(p)) throw new Error(`unsupported character in path: ${p}`);
  return `'${p.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}'`;
};

// ---- ingest ------------------------------------------------------------------

export const PROXY_LONG = 720;

export const proxyArgs = (src: string, out: string, probe: Pick<Probe, "width" | "height">, enc: Encoder): string[] => {
  const { w, h } = fitLong(probe.width, probe.height, PROXY_LONG);
  return [
    ...common,
    ...hwInput(enc),
    "-i", src,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", `scale=${w}:${h}:flags=bicubic,setsar=1,${encTail(enc)}`,
    ...videoCodec(enc, "proxy"),
    "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    out,
  ];
};

/** 48 kHz stereo PCM master; silence of the clip's length when there is no audio. */
export const wav48Args = (src: string, out: string, hasAudio: boolean, durationMs: number): string[] =>
  hasAudio
    ? [...common, "-i", src, "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", out]
    : [...common, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", (durationMs / 1000).toFixed(3), "-c:a", "pcm_s16le", out];

export const wav16Args = (wav48: string, out: string): string[] => [
  ...common, "-i", wav48, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out,
];

export const thumbArgs = (src: string, out: string, durationMs: number): string[] => [
  "-hide_banner", "-nostdin", "-y",
  "-ss", (Math.min(1000, durationMs / 2) / 1000).toFixed(3),
  "-i", src, "-frames:v", "1", "-vf", "scale=-2:480", "-q:v", "4", out,
];

// ---- audio ---------------------------------------------------------------------

/** Stem mix, sample-exact: speech + background at `bgDb` (null → speech only). */
export const mixArgs = (speech: string, background: string, bgDb: number | null, out: string): string[] =>
  bgDb === null
    ? [...common, "-i", speech, "-c:a", "pcm_s16le", "-ar", "48000", out]
    : [
        ...common,
        "-i", speech, "-i", background,
        "-filter_complex", `[1:a]volume=${bgDb}dB[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[m]`,
        "-map", "[m]", "-c:a", "pcm_s16le", "-ar", "48000", out,
      ];

export const LOUDNORM = "I=-16:TP=-1.5:LRA=11";

export const loudnormMeasureArgs = (src: string, startMs: number, endMs: number): string[] => [
  "-hide_banner", "-nostdin",
  "-ss", (startMs / 1000).toFixed(3), "-t", ((endMs - startMs) / 1000).toFixed(3),
  "-i", src, "-af", `loudnorm=${LOUDNORM}:print_format=json`, "-f", "null", "-",
];

export interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export const parseLoudnorm = (stderr: string): LoudnormMeasure => {
  const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr);
  if (!m) throw new Error("loudnorm: no measurement in ffmpeg output");
  return JSON.parse(m[0]) as LoudnormMeasure;
};

export const loudnormApplyArgs = (src: string, startMs: number, endMs: number, m: LoudnormMeasure, out: string): string[] => {
  // Silent input measures -inf; just pass it through.
  const finite = [m.input_i, m.input_tp, m.input_lra, m.input_thresh].every((x) => Number.isFinite(Number(x)));
  const af = finite
    ? `loudnorm=${LOUDNORM}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`
    : "anull";
  return [
    ...common,
    "-ss", (startMs / 1000).toFixed(3), "-t", ((endMs - startMs) / 1000).toFixed(3),
    "-i", src, "-af", af, "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", out,
  ];
};

// ---- framing / render ------------------------------------------------------------

export const outputSize = (framing: Pick<Framing, "ratio">, probe: Pick<Probe, "width" | "height">): { w: number; h: number } => {
  if (framing.ratio === "9:16") return { w: 1080, h: 1920 };
  if (framing.ratio === "16:9") return { w: 1920, h: 1080 };
  return fitLong(probe.width, probe.height, 1920);
};

/** Crop window of the output aspect inside the source, centred on (cx, cy) and clamped. */
export const cropRect = (
  src: { w: number; h: number },
  out: { w: number; h: number },
  centre: { cx: number; cy: number } = { cx: 0.5, cy: 0.5 },
): { w: number; h: number; x: number; y: number } => {
  const target = out.w / out.h;
  let w = src.w;
  let h = src.h;
  if (src.w / src.h > target) w = Math.min(src.w, even(src.h * target));
  else h = Math.min(src.h, even(src.w / target));
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const x = even(clamp(centre.cx * src.w - w / 2, 0, src.w - w));
  const y = even(clamp(centre.cy * src.h - h / 2, 0, src.h - h));
  return { w, h, x: Math.min(x, src.w - w), y: Math.min(y, src.h - h) };
};

/** Filtergraph from [0:v] to a framed `[base]` of exactly W×H. */
export const framingGraph = (framing: Framing, probe: Pick<Probe, "width" | "height">, out: { w: number; h: number }): string => {
  const { w: W, h: H } = out;
  if (framing.fit === "fill") {
    const kf = framing.keyframes[0];
    const c = cropRect({ w: probe.width, h: probe.height }, out, kf ? { cx: kf.cx, cy: kf.cy } : undefined);
    return `[0:v]crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${W}:${H}:flags=lanczos,setsar=1[base]`;
  }
  const fg = `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,setsar=1`;
  if (framing.fit === "fit_solid") {
    return `[0:v]${fg},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black[base]`;
  }
  const bw = even(W / 8);
  const bh = even(H / 8);
  return (
    `[0:v]split=2[bgsrc][fgsrc];` +
    `[bgsrc]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=6:2,scale=${W}:${H},setsar=1[bg];` +
    `[fgsrc]${fg}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`
  );
};

export interface RenderPlan {
  src: string;
  /** 48 kHz processed audio; null = source audio. */
  audio: string | null;
  hasSourceAudio: boolean;
  probe: Pick<Probe, "width" | "height">;
  framing: Framing;
  out: { w: number; h: number };
  captioned: { path: string; ass: string } | null;
  clean: { path: string } | null;
  fontsDir: string;
}

export const renderArgs = (p: RenderPlan, enc: Encoder): string[] => {
  const outs: { label: string; path: string; chain: string }[] = [];
  if (p.captioned) {
    outs.push({
      label: "vc",
      path: p.captioned.path,
      chain: `ass=filename=${filterPath(p.captioned.ass)}:fontsdir=${filterPath(p.fontsDir)},${encTail(enc)}`,
    });
  }
  if (p.clean) outs.push({ label: "vk", path: p.clean.path, chain: encTail(enc) });
  if (!outs.length) throw new Error("render: nothing to output");

  let graph = framingGraph(p.framing, p.probe, p.out);
  if (outs.length === 2) {
    graph += `;[base]split=2[b0][b1]`;
    outs.forEach((o, i) => (graph += `;[b${i}]${o.chain}[${o.label}]`));
  } else {
    graph += `;[base]${outs[0]!.chain}[${outs[0]!.label}]`;
  }

  const args = [...common, ...hwInput(enc), "-i", p.src];
  if (p.audio) args.push("-i", p.audio);
  args.push("-filter_complex", graph);
  const audioMap = p.audio ? ["-map", "1:a:0"] : p.hasSourceAudio ? ["-map", "0:a:0"] : [];
  for (const o of outs) {
    args.push(
      "-map", `[${o.label}]`, ...audioMap,
      ...videoCodec(enc, "final"),
      ...(audioMap.length ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []),
      "-movflags", "+faststart",
      o.path,
    );
  }
  return args;
};
