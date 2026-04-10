import { AbsoluteFill, Video } from "remotion";
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
}) => {
  const chunks = transcript ? chunkWords(transcript.words) : [];

  const CaptionComponent =
    style === "clean" ? Clean : style === "focus" ? Focus : Bold;

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
      <ReelsSafeZoneMock visible={false} />
    </AbsoluteFill>
  );
};
