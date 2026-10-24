import { useSyncExternalStore } from "react";

// One playback controller around the project's <video>. Time is ms and is
// published every animation frame while playing (timeupdate is too coarse for
// word highlighting). Ranges play once or loop (context playback).

export interface PlayRange {
  start: number;
  end: number;
  loop: boolean;
}

type Listener = () => void;

export class Player {
  video: HTMLVideoElement | null = null;
  time = 0;
  duration = 0;
  playing = false;
  range: PlayRange | null = null;
  /** Play was requested but frames aren't flowing yet (network / decode). */
  buffering = false;
  error: string | null = null;
  /** External audio is driving (comparison player); video is a muted picture. */
  slaved = false;
  private listeners = new Set<Listener>();
  private raf = 0;
  private snapshot = {
    time: 0,
    playing: false,
    duration: 0,
    range: null as PlayRange | null,
    buffering: false,
    error: null as string | null,
  };

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    const s = this.snapshot;
    if (
      s.time !== this.time ||
      s.playing !== this.playing ||
      s.duration !== this.duration ||
      s.range !== this.range ||
      s.buffering !== this.buffering ||
      s.error !== this.error
    )
      this.snapshot = {
        time: this.time,
        playing: this.playing,
        duration: this.duration,
        range: this.range,
        buffering: this.buffering,
        error: this.error,
      };
    this.listeners.forEach((l) => l());
  }

  attach(v: HTMLVideoElement | null) {
    if (this.video === v) return;
    this.video = v;
    if (!v) return;
    const sync = () => {
      this.time = Math.round(v.currentTime * 1000);
      this.duration = Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : this.duration;
      this.playing = !v.paused && !v.ended;
      if (this.playing) this.loop();
      this.emit();
    };
    for (const ev of ["play", "pause", "seeked", "loadedmetadata", "ended", "timeupdate", "durationchange"])
      v.addEventListener(ev, sync);
    const setBuffering = (b: boolean) => () => {
      this.buffering = b && !v.paused;
      if (!b) this.error = null;
      this.emit();
    };
    v.addEventListener("waiting", setBuffering(true));
    v.addEventListener("playing", setBuffering(false));
    v.addEventListener("pause", setBuffering(false));
    v.addEventListener("error", () => {
      this.buffering = false;
      this.error = "Видео не загрузилось — проверьте соединение";
      this.emit();
    });
    sync();
  }

  private loop() {
    if (this.raf) return;
    const step = () => {
      this.raf = 0;
      const v = this.video;
      if (!v || v.paused) return;
      this.time = Math.round(v.currentTime * 1000);
      const r = this.range;
      if (r && this.time >= r.end) {
        if (r.loop) v.currentTime = r.start / 1000;
        else {
          v.pause();
          this.range = null;
        }
      }
      this.emit();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  seek(ms: number) {
    const v = this.video;
    if (!v) return;
    const t = Math.max(0, Math.min(ms, this.duration || ms));
    v.currentTime = t / 1000;
    this.time = Math.round(t);
    if (this.range && (t < this.range.start || t > this.range.end)) this.range = null;
    this.emit();
  }

  play() {
    const v = this.video;
    if (!v || this.slaved) return;
    v.muted = false;
    this.error = null;
    // Until the first frame plays, show that the press registered.
    if (v.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) this.buffering = true;
    this.emit();
    v.play().catch((e: unknown) => {
      this.buffering = false;
      const name = (e as { name?: string })?.name;
      if (name !== "AbortError") this.error = name === "NotAllowedError" ? "Браузер не дал включить звук — нажмите ещё раз" : "Не удалось воспроизвести";
      this.emit();
    });
  }

  pause() {
    this.video?.pause();
  }

  toggle() {
    if (this.playing || this.buffering) {
      this.buffering = false;
      this.pause();
      this.range = null;
      this.emit();
    } else this.play();
  }

  playRange(start: number, end: number, loop = false) {
    this.range = { start, end, loop };
    this.seek(start);
    this.range = { start, end, loop };
    this.play();
    this.emit();
  }

  stopRange() {
    this.range = null;
    this.pause();
    this.emit();
  }

  skip(deltaMs: number) {
    this.seek(this.time + deltaMs);
  }
}

export const usePlayerState = (p: Player) => useSyncExternalStore(p.subscribe, p.getSnapshot);
