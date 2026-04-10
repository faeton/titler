import { Composition } from "remotion";
import { TitlerVideo } from "./compositions/TitlerVideo";
import {
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  VIDEO_FPS,
  type CompositionProps,
} from "./types";

// M0: placeholder composition. The sourceUrl points at the normalized
// 1080x1920 MP4 served by the local Node server; transcript is null
// until M1 wires the editor in.
const defaultProps: CompositionProps = {
  sourceUrl: "",
  transcript: null,
  durationInSeconds: 10,
  circle: null,
  style: "bold",
};

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="TitlerVideo"
        component={TitlerVideo}
        durationInFrames={VIDEO_FPS * 60} // placeholder; overridden per-render
        fps={VIDEO_FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(
            1,
            Math.round((props.durationInSeconds || 10) * VIDEO_FPS),
          ),
        })}
      />
    </>
  );
};
