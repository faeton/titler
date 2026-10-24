import { useEffect, useRef } from "react";

/** Blurred cover of the playing video ("Вписать с размытием"), drawn to a small canvas. */
export const BlurBackdrop = ({ video }: { video: HTMLVideoElement | null }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !video) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = 0;
    const draw = () => {
      if (!video.videoWidth) return;
      const ar = video.videoWidth / video.videoHeight;
      const car = c.width / c.height;
      const [sw, sh] = ar > car ? [video.videoHeight * car, video.videoHeight] : [video.videoWidth, video.videoWidth / car];
      try {
        ctx.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height);
      } catch {
        /* not ready */
      }
    };
    const loop = (t: number) => {
      if (t - last > 66) {
        draw();
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [video]);
  return <canvas ref={ref} className="blur" width={54} height={96} aria-hidden />;
};
