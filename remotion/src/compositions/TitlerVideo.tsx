import { AbsoluteFill, Video, useCurrentFrame, useVideoConfig } from "remotion";
import type { CompositionProps } from "../types";
import { chunkWords } from "../lib/chunk";
import { Bold } from "../styles/Bold";
import { Clean } from "../styles/Clean";
import { Focus } from "../styles/Focus";
import { ReelsSafeZoneMock } from "../overlays/ReelsSafeZoneMock";

export const TitlerVideo: React.FC<CompositionProps> = ({
  sourceUrl,
  transcript,
  circle,
  style = "bold",
  showSafeZone = false,
  overlays = [],
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTime = frame / fps;

  const chunks = transcript ? chunkWords(transcript.words) : [];

  const CaptionComponent =
    style === "clean" ? Clean : style === "focus" ? Focus : Bold;

  const activeOverlays = overlays.filter(
    (ov) => currentTime >= ov.start && currentTime < ov.end,
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {sourceUrl ? (
        <Video src={sourceUrl} />
      ) : (
        <AbsoluteFill
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#666",
            fontFamily: "system-ui, -apple-system, sans-serif",
            fontSize: 48,
          }}
        >
          no source
        </AbsoluteFill>
      )}
      {chunks.length > 0 && (
        <CaptionComponent chunks={chunks} circle={circle} />
      )}
      {activeOverlays.map((ov) => (
        <div
          key={ov.id}
          style={{
            position: "absolute",
            left: ov.x,
            top: ov.y,
            fontSize: ov.fontSize,
            fontWeight: ov.fontWeight,
            color: ov.color,
            fontFamily: '"Arial Black", "Arial", system-ui, sans-serif',
            textAlign: "center",
            transform: "translate(-50%, -50%)",
            WebkitTextStroke: ov.outline
              ? "4px rgba(0,0,0,0.9)"
              : undefined,
            paintOrder: ov.outline ? "stroke fill" : undefined,
            filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.5))",
          }}
        >
          {ov.text}
        </div>
      ))}
      <ReelsSafeZoneMock visible={showSafeZone} />
    </AbsoluteFill>
  );
};
