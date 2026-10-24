// Gapless A/B/C/D comparison: every variant is decoded into memory and all of
// them play in lock-step from one AudioContext clock; switching only moves
// gains (short ramp), so the position is kept exactly and there is no reload gap.

export class AbPlayer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private gains = new Map<string, GainNode>();
  private sources: AudioBufferSourceNode[] = [];
  private startedAt = 0;
  private offset = 0;
  private gen = 0;
  active = "original";
  loop = true;
  playing = false;
  duration = 0;
  onEnded: (() => void) | null = null;

  private context(): AudioContext {
    if (!this.ctx) {
      // iOS mutes Web Audio when the ring/silent switch is on unless the page
      // declares itself a media player (Safari 16.4+).
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = "playback";
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  async load(variants: Record<string, string>, signal?: AbortSignal): Promise<void> {
    this.stop();
    this.offset = 0;
    const ctx = this.context();
    const entries = await Promise.all(
      Object.entries(variants).map(async ([k, url]) => {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`${k}: HTTP ${res.status}`);
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        return [k, buf] as const;
      }),
    );
    this.buffers = new Map(entries);
    this.gains.forEach((g) => g.disconnect());
    this.gains = new Map(
      entries.map(([k]) => {
        const g = ctx.createGain();
        g.gain.value = k === this.active ? 1 : 0;
        g.connect(ctx.destination);
        return [k, g];
      }),
    );
    this.duration = Math.min(...entries.map(([, b]) => b.duration));
    if (!this.buffers.has(this.active)) this.setActive(entries[0]?.[0] ?? "original");
  }

  position(): number {
    if (!this.playing || !this.ctx) return this.offset;
    const p = this.ctx.currentTime - this.startedAt;
    return this.loop ? p % this.duration : Math.min(p, this.duration);
  }

  async play(from = this.offset) {
    const ctx = this.context();
    if (ctx.state === "suspended") await ctx.resume();
    this.killSources();
    const gen = ++this.gen;
    const when = ctx.currentTime + 0.04;
    const at = Math.max(0, Math.min(from, this.duration - 0.01));
    for (const [k, buf] of this.buffers) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = this.loop;
      src.loopEnd = this.duration;
      src.connect(this.gains.get(k)!);
      src.start(when, at);
      if (k === this.active)
        src.onended = () => {
          if (gen !== this.gen) return;
          this.playing = false;
          this.offset = 0;
          this.onEnded?.();
        };
      this.sources.push(src);
    }
    this.startedAt = when - at;
    this.playing = true;
  }

  pause() {
    this.offset = this.position();
    this.stop();
  }

  private killSources() {
    this.gen++;
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
      s.disconnect();
    }
    this.sources = [];
  }

  stop() {
    this.killSources();
    this.playing = false;
  }

  seek(sec: number) {
    if (this.playing) void this.play(sec);
    else this.offset = sec;
  }

  setActive(key: string) {
    this.active = key;
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [k, g] of this.gains) g.gain.setTargetAtTime(k === key ? 1 : 0, ctx.currentTime, 0.008);
  }

  setLoop(loop: boolean) {
    this.loop = loop;
    if (this.playing) void this.play(this.position());
  }

  dispose() {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
