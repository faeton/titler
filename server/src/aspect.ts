import {
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  type AspectStrategy,
  type ProbeInfo,
  type CircleLayout,
  type FaceTrackResult,
} from "./types.js";

// Pick an aspect strategy for fitting an arbitrary source into the
// 1080x1920 target and build the corresponding ffmpeg filter graph.
//
//   crop             — source is portrait-ish (ratio < 1, e.g. 3:4):
//                      upscale so height = 1920, center-crop width to
//                      1080. Loses ~25% of width on 3:4 sources, which
//                      is acceptable for a centered subject.
//   blur_fill        — source is square-ish or landscape (ratio >= 1):
//                      stretch the source non-uniformly to fill the
//                      frame, Gaussian-blur heavily, dim slightly;
//                      place a ratio-preserving scaled copy on top.
//                      Standard Instagram Stories / Reels look.
//   telegram_circle  — source is a Telegram round video (square
//                      container with uniform padding in the corners,
//                      inscribed circle of content). Mask the circle
//                      with geq, place in the upper half of the frame
//                      on a solid black background; leave the lower
//                      ~400px of the safe zone for captions.
//   letterbox        — explicit override fallback: fit source inside
//                      1080x1920 with black bars. Not auto-picked.

const TARGET_RATIO = VIDEO_WIDTH / VIDEO_HEIGHT; // 0.5625
const EPS = 0.01;

// Telegram circle layout inside the 1080x1920 frame.
// Circle occupies roughly the upper half of the Reels safe zone so
// there's ~420px of caption space below it but still inside the
// bottom Reels UI-chrome boundary (y=1470).
export const TELEGRAM_CIRCLE_LAYOUT: CircleLayout = {
  x: (VIDEO_WIDTH - 780) / 2, // 150
  y: 270,
  size: 780,
};

export const pickStrategy = (probe: ProbeInfo): AspectStrategy => {
  const ratio = probe.width / probe.height;
  if (Math.abs(ratio - TARGET_RATIO) < EPS) return "crop"; // already 9:16
  if (ratio < 1) return "crop"; // portrait-ish
  return "blur_fill"; // square or landscape
};

// Compute a static crop X offset from face tracking data.
// Uses the median keyframe X position (mapped to the target resolution)
// to keep the face centered in the 1080-wide crop window.
export const computeFaceTrackOffset = (
  ft: FaceTrackResult,
  scaledHeight: number,
): number => {
  if (!ft.found || ft.keyframes.length === 0) return -1; // center fallback
  // The keyframes are in source coordinates. We need to map to the
  // scaled frame where height = VIDEO_HEIGHT.
  const scale = scaledHeight / ft.source_height;
  const scaledWidth = Math.round(ft.source_width * scale);
  const xs = ft.keyframes.map((kf) => Math.round(kf.x * scale));
  xs.sort((a, b) => a - b);
  const medianX = xs[Math.floor(xs.length / 2)];
  // Clamp so the crop window stays inside the scaled frame
  const maxX = Math.max(0, scaledWidth - VIDEO_WIDTH);
  return Math.max(0, Math.min(medianX, maxX));
};

export const buildVideoFilter = (
  strategy: AspectStrategy,
  opts?: { circle?: CircleLayout; faceTrack?: FaceTrackResult },
): string => {
  switch (strategy) {
    case "crop": {
      const cropX =
        opts?.faceTrack
          ? computeFaceTrackOffset(opts.faceTrack, VIDEO_HEIGHT)
          : -1;
      // cropX = -1 means center (ffmpeg default when crop x is omitted or (iw-ow)/2)
      const xExpr = cropX >= 0 ? String(cropX) : "(in_w-out_w)/2";
      return [
        `scale=-2:${VIDEO_HEIGHT}:flags=lanczos`,
        `crop=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:${xExpr}:0`,
        `fps=30`,
        `setsar=1`,
      ].join(",");
    }

    case "blur_fill":
      // Stretched background + Gaussian blur + slight darken + sharp
      // foreground composited on top. See PLAN v2 / user discussion.
      return [
        `[0:v]split=2[bg][fg]`,
        `[bg]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT},gblur=sigma=80,eq=brightness=-0.08[bgblur]`,
        `[fg]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease[fgfit]`,
        `[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2,fps=30,setsar=1[vout]`,
      ].join(";");

    case "telegram_circle": {
      const layout = opts?.circle ?? TELEGRAM_CIRCLE_LAYOUT;
      // Mask the source to a circle using geq's alpha expression, then
      // scale the masked circle to the target diameter and overlay it
      // on a 1080x1920 solid black background. We take the black bg
      // from a second copy of the source (scaled + drawbox-filled) so
      // the filter has correct timebase without a separate lavfi
      // input. Mask radius uses 0.94 × W/2 for a 3% safety margin
      // that clips the Telegram white-padding antialiasing.
      //
      // Escaped commas inside the geq expression are required because
      // the filter-complex parser would otherwise split on them.
      return [
        `[0:v]split=2[src1][src2]`,
        `[src1]format=yuva420p,geq=lum='p(X\\,Y)':cb='p(X\\,Y)':cr='p(X\\,Y)':a='if(lte(hypot(X-W/2\\,Y-H/2)\\,W/2*0.94)\\,255\\,0)',scale=${layout.size}:${layout.size}[circ]`,
        `[src2]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT},drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill[bg]`,
        `[bg][circ]overlay=${layout.x}:${layout.y},fps=30,setsar=1[vout]`,
      ].join(";");
    }

    case "letterbox":
      return [
        `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos`,
        `pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
        `fps=30`,
        `setsar=1`,
      ].join(",");
  }
};

// Returns true when the strategy produces a filter graph that needs
// -filter_complex and a named -map [vout]; false when plain -vf works.
export const isComplexFilter = (strategy: AspectStrategy): boolean =>
  strategy === "blur_fill" || strategy === "telegram_circle";
