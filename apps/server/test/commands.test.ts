import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileCues, DEFAULT_FRAMING, DEFAULT_STYLE, docFromHypothesis, toAss } from "@titler/core";
import { loadConfig } from "../src/config.js";
import { artifactKey, canonical } from "../src/context.js";
import { cropRect, filterPath, fitLong, framingGraph, mixArgs, outputSize, parseLoudnorm, proxyArgs, renderArgs } from "../src/media/commands.js";
import { parseProbe } from "../src/media/probe.js";
import { pickExcerpts } from "../src/pipeline/audio.js";
import { stamp } from "../src/pipeline/render.js";
import { HERE, rmDir, tmpDir } from "./helpers.js";

const HW = { kind: "vaapi", vaapiDevice: "/dev/dri/renderD128" } as const;
const VT = { kind: "videotoolbox", vaapiDevice: "/dev/dri/renderD128" } as const;
const SW = { kind: "software", vaapiDevice: "/dev/dri/renderD128" } as const;
const FONTS = resolve(HERE, "../../../assets/fonts");

describe("artifact keys", () => {
  it("are stable under param key order and change with inputs", () => {
    expect(canonical({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[1,{"y":2,"z":1}],"d":2},"b":1}');
    const k = artifactKey("proxy", ["sha"], { a: 1, b: 2 }, "v1");
    expect(artifactKey("proxy", ["sha"], { b: 2, a: 1 }, "v1")).toBe(k);
    expect(artifactKey("proxy", ["sha"], { a: 1, b: 2 }, "v2")).not.toBe(k);
    expect(artifactKey("proxy", ["sha2"], { a: 1, b: 2 }, "v1")).not.toBe(k);
  });
});

describe("probe", () => {
  it("swaps dims for rotated video and prefers the recording date", () => {
    const p = parseProbe({
      streams: [
        { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, r_frame_rate: "30000/1001", side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] },
        { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
      ],
      format: {
        duration: "12.3456",
        tags: { creation_time: "2026-10-21T14:29:41.000000Z", "com.apple.quicktime.creationdate": "2026-10-21T04:14:52Z", "com.apple.quicktime.model": "Meta Smart Glasses" },
      },
    });
    expect(p).toMatchObject({ width: 1080, height: 1920, rotation: 270, durationMs: 12346, videoCodec: "hevc", audioCodec: "aac", createdAt: "2026-10-21T04:14:52.000Z", device: "Meta Smart Glasses" });
    expect(p.fps).toBeCloseTo(29.97, 2);
  });
});

describe("geometry", () => {
  it("fits the long side with even dims", () => {
    expect(fitLong(1376, 1840, 1080)).toEqual({ w: 808, h: 1080 });
    expect(fitLong(640, 360, 1080)).toEqual({ w: 640, h: 360 });
  });
  it("crops 9:16 from a portrait 3:4 source, clamped to the frame", () => {
    expect(cropRect({ w: 1376, h: 1840 }, { w: 1080, h: 1920 })).toEqual({ w: 1036, h: 1840, x: 170, y: 0 });
    expect(cropRect({ w: 1376, h: 1840 }, { w: 1080, h: 1920 }, { cx: 1, cy: 0.5 })).toEqual({ w: 1036, h: 1840, x: 340, y: 0 });
    expect(cropRect({ w: 1376, h: 1840 }, { w: 1920, h: 1080 })).toEqual({ w: 1376, h: 774, x: 0, y: 534 });
  });
  it("output sizes per ratio", () => {
    expect(outputSize({ ratio: "9:16" }, { width: 1, height: 1 })).toEqual({ w: 1080, h: 1920 });
    expect(outputSize({ ratio: "source" }, { width: 3840, height: 2160 })).toEqual({ w: 1920, h: 1080 });
  });
  it("framing graphs", () => {
    const probe = { width: 1376, height: 1840 };
    expect(framingGraph(DEFAULT_FRAMING, probe, { w: 1080, h: 1920 })).toBe("[0:v]crop=1036:1840:170:0,scale=1080:1920:flags=lanczos,setsar=1[base]");
    expect(framingGraph({ ratio: "16:9", fit: "fit_solid", keyframes: [] }, probe, { w: 1920, h: 1080 })).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black[base]");
    const blur = framingGraph({ ratio: "16:9", fit: "fit_blur", keyframes: [] }, probe, { w: 1920, h: 1080 });
    expect(blur).toMatch(/^\[0:v\]split=2\[bgsrc\]\[fgsrc\];.*boxblur.*overlay=\(W-w\)\/2:\(H-h\)\/2\[base\]$/);
  });
});

describe("ffmpeg commands", () => {
  it("proxy: VAAPI decode + CPU scale + h264_vaapi, libx264 fallback", () => {
    const hw = proxyArgs("/s.mov", "/p.mp4", { width: 1376, height: 1840 }, HW).join(" ");
    expect(hw).toContain("-init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va -hwaccel vaapi -hwaccel_device va -i /s.mov");
    expect(hw).not.toContain("-hwaccel_output_format"); // keep CPU autorotate working
    expect(hw).toContain("-vf scale=538:720:flags=bicubic,setsar=1,format=nv12,hwupload");
    expect(hw).toContain("-c:v h264_vaapi -rc_mode VBR -b:v 1800k -maxrate 2500k");
    expect(hw).toContain("-movflags +faststart /p.mp4");
    const sw = proxyArgs("/s.mov", "/p.mp4", { width: 1376, height: 1840 }, SW).join(" ");
    expect(sw).not.toContain("vaapi");
    expect(sw).toContain("-c:v libx264 -preset veryfast");
    expect(sw).toContain("format=yuv420p");
  });

  it("proxy: CPU decode + CPU scale + h264_videotoolbox, no hwupload", () => {
    const vt = proxyArgs("/s.mov", "/p.mp4", { width: 1376, height: 1840 }, VT).join(" ");
    expect(vt).not.toContain("-hwaccel");
    expect(vt).not.toContain("vaapi");
    expect(vt).not.toContain("hwupload");
    expect(vt).toContain("-vf scale=538:720:flags=bicubic,setsar=1,format=nv12");
    expect(vt).toContain("-c:v h264_videotoolbox -allow_sw 0 -profile:v high -b:v 1800k -maxrate 2500k");
  });

  it("render: one decode, split into captioned + clean, ass with fontsdir, variant audio", () => {
    const args = renderArgs(
      {
        src: "/data/sources/x.mov",
        audio: "/data/artifacts/k/out.wav",
        hasSourceAudio: true,
        probe: { width: 1376, height: 1840 },
        framing: DEFAULT_FRAMING,
        out: { w: 1080, h: 1920 },
        captioned: { path: "/o/cap.mp4", ass: "/o/subs.ass" },
        clean: { path: "/o/clean.mp4" },
        fontsDir: "/repo/assets/fonts",
      },
      HW,
    );
    const s = args.join(" ");
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toBe(
      "[0:v]crop=1036:1840:170:0,scale=1080:1920:flags=lanczos,setsar=1[base];[base]split=2[b0][b1];" +
        "[b0]ass=filename='/o/subs.ass':fontsdir='/repo/assets/fonts',format=nv12,hwupload[vc];[b1]format=nv12,hwupload[vk]",
    );
    expect(s).toContain("-i /data/sources/x.mov -i /data/artifacts/k/out.wav");
    expect(s).toContain("-map [vc] -map 1:a:0 -c:v h264_vaapi -rc_mode CQP -qp 21 -profile:v high -c:a aac");
    expect(s).toContain("-map [vk] -map 1:a:0");
    expect(args.at(-1)).toBe("/o/clean.mp4");
  });

  it("render on VideoToolbox: CPU libass, nv12 tail, constant-quality h264_videotoolbox", () => {
    const args = renderArgs(
      { src: "/s.mov", audio: null, hasSourceAudio: true, probe: { width: 1376, height: 1840 }, framing: DEFAULT_FRAMING, out: { w: 1080, h: 1920 }, captioned: { path: "/o/cap.mp4", ass: "/o/subs.ass" }, clean: null, fontsDir: "/f" },
      VT,
    );
    const s = args.join(" ");
    expect(args[args.indexOf("-filter_complex") + 1]).toBe(
      "[0:v]crop=1036:1840:170:0,scale=1080:1920:flags=lanczos,setsar=1[base];[base]ass=filename='/o/subs.ass':fontsdir='/f',format=nv12[vc]",
    );
    expect(s).not.toContain("-hwaccel");
    expect(s).toContain("-map [vc] -map 0:a:0 -c:v h264_videotoolbox -allow_sw 0 -profile:v high -q:v 65 -c:a aac");
  });

  it("render without variant maps source audio; libx264 path", () => {
    const s = renderArgs(
      { src: "/s.mov", audio: null, hasSourceAudio: true, probe: { width: 640, height: 360 }, framing: { ratio: "source", fit: "fill", keyframes: [] }, out: { w: 640, h: 360 }, captioned: null, clean: { path: "/c.mp4" }, fontsDir: "/f" },
      SW,
    ).join(" ");
    expect(s).toContain("[base]format=yuv420p[vk]");
    expect(s).toContain("-map [vk] -map 0:a:0 -c:v libx264");
    expect(s).not.toContain("ass=");
  });

  it("escapes filter paths and refuses quotes", () => {
    expect(filterPath("/a:b/c.ass")).toBe("'/a\\:b/c.ass'");
    expect(() => filterPath("/it's.ass")).toThrow();
  });

  it("stem mix is sample-exact amix without normalisation", () => {
    expect(mixArgs("/s.wav", "/b.wav", -12, "/o.wav").join(" ")).toContain("[1:a]volume=-12dB[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[m]");
    expect(mixArgs("/s.wav", "/b.wav", null, "/o.wav")).not.toContain("-filter_complex");
  });

  it("parses loudnorm measurement", () => {
    const m = parseLoudnorm('[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-27.61",\n\t"input_tp" : "-4.47",\n\t"input_lra" : "18.06",\n\t"input_thresh" : "-39.20",\n\t"target_offset" : "0.58"\n}\n');
    expect(m.input_i).toBe("-27.61");
  });

  it("file name stamp from recording time", () => {
    expect(stamp({ probe: { createdAt: "2026-10-21T04:14:52Z" } as never, createdAt: "2026-10-24T00:00:00Z" })).toBe("20261021_041452");
    expect(stamp({ probe: null, createdAt: "2026-10-24T01:02:03.000Z" })).toBe("20261024_010203");
  });
});

describe("excerpts", () => {
  it("picks a calm and a noisy window", () => {
    // 40 s: speech everywhere except short pauses; background loud in 20–30 s.
    const db = Array.from({ length: 400 }, (_, i) => {
      const pause = i % 20 >= 16;
      const noisy = i >= 200 && i < 300;
      return pause ? (noisy ? -25 : -60) : -20;
    });
    const speech = Array.from({ length: 20 }, (_, k) => ({ startMs: k * 2000, endMs: k * 2000 + 1600 }));
    const ex = pickExcerpts(db, speech, 40_000);
    expect(ex[0]!.excerpt).toBe("calm");
    expect(ex[0]!.startMs < 20_000 - 9000 || ex[0]!.startMs >= 30_000).toBe(true);
    expect(ex[1]!.excerpt).toBe("noisy");
    expect(ex[1]!.startMs).toBeGreaterThanOrEqual(15_500); // window overlaps the noisy 20–30 s span by > half
    expect(ex[1]!.startMs).toBeLessThanOrEqual(23_000);
  });
  it("short clips are one excerpt", () => {
    expect(pickExcerpts([-20, -20], [], 5000)).toEqual([{ excerpt: "calm", startMs: 0, endMs: 5000 }]);
  });
});

describe("libass burn-in (real ffmpeg)", () => {
  const ff = loadConfig().ffmpeg; // ~/.local/bin/ffmpeg on n5, PATH (ffmpeg-full) on the Mac
  const hasLibass = / ass +V->V/.test(spawnSync(ff, ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout ?? "");
  const dir = tmpDir();
  afterAll(() => rmDir(dir));
  it.skipIf(!hasLibass)("resolves Montserrat Bold from assets/fonts for Cyrillic captions", () => {
    const doc = docFromHypothesis({ id: "h", words: [{ text: "Привіт,", start: 0, end: 400 }, { text: "Самоа!", start: 450, end: 900 }] });
    const assPath = join(dir, "s.ass");
    writeFileSync(assPath, toAss(compileCues(doc, DEFAULT_STYLE, 1000), { width: 1080, height: 1920, style: DEFAULT_STYLE }));
    const res = spawnSync(
      ff,
      ["-hide_banner", "-v", "debug", "-f", "lavfi", "-i", "color=c=gray:s=1080x1920:d=0.5", "-vf", `ass=filename=${filterPath(assPath)}:fontsdir=${filterPath(FONTS)}`, "-frames:v", "1", "-f", "null", "-"],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/fontselect: \(Montserrat, 700, 0\) -> Montserrat-Bold/);
    expect(res.stderr).not.toMatch(/Glyph 0x[0-9A-F]+ not found/);
  });
});
