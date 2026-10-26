#!/usr/bin/env node
// Minimal stand-in for workers/titler_worker that speaks docs/worker-protocol.md.
// Env: FAKE_ALIGN_DELAY_MS (delay per align_window), FAKE_ASR_DELAY_MS,
// FAKE_HANG_START (never print ready), FAKE_HANG_ONCE (marker file: `load` hangs only
// while it doesn't exist, then creates it).
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const role = process.argv[process.argv.indexOf("--role") + 1] ?? "unknown";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (k, d = 0) => Number(process.env[k] ?? d);

const ops = {
  ping: async () => ({ role, models: [] }),
  sleep: async (m) => (await sleep(m.ms ?? 1000), { slept: m.ms }),
  crash: async () => process.exit(3),
  // "loading model" progress, then silence: what a stuck model load looks like
  load: async (m, id) => {
    send({ id, progress: 0, message: "loading model" });
    const once = process.env.FAKE_HANG_ONCE;
    if (once && existsSync(once)) return { loaded: true };
    if (once) writeFileSync(once, "");
    await sleep(m.ms ?? 60_000);
    return { loaded: true };
  },
  echo: async (m, id) => {
    send({ id, progress: 0.5, message: "half" });
    return { echo: m.value };
  },
  analyze: async (m) => {
    writeFileSync(m.peaks_out, JSON.stringify({ rate: 100, peaks: [[-10, 10], [-20, 20]] }));
    writeFileSync(m.vad_out, JSON.stringify({ regions: [{ startMs: 0, endMs: 2000 }], model: "fake" }));
    return { speechMs: 2000, regions: 1 };
  },
  asr: async (m, id) => {
    await sleep(env("FAKE_ASR_DELAY_MS"));
    send({ id, progress: 0.5, message: "decoding" });
    return {
      lang: "ru",
      provider: m.provider,
      model: m.model ?? "fake-turbo",
      words: [
        { text: "я", start: 100, end: 300 },
        { text: "приехал", start: 320, end: 800 },
        { text: "Самоа.", start: 1000, end: 1600 },
      ],
      timing: { load_ms: 1, infer_ms: 1 },
    };
  },
  align_precompute: async () => ({ ms: 1 }),
  align_forget: async () => ({}),
  align_window: async (m) => {
    await sleep(env("FAKE_ALIGN_DELAY_MS"));
    const n = m.words.length;
    const step = Math.floor((m.t1 - m.t0) / Math.max(1, n));
    return {
      words: m.words.map((_, i) => {
        const a = m.anchors?.[String(i)];
        if (a) return { start: a[0], end: a[1], status: "anchor" };
        return { start: m.t0 + i * step, end: m.t0 + (i + 1) * step - 10, status: "aligned" };
      }),
      ms: 1,
    };
  },
  enhance: async (m) => {
    if (m.engine === "mf2") {
      copyFileSync(m.wav48, `${m.out_dir}/speech.wav`);
      copyFileSync(m.wav48, `${m.out_dir}/background.wav`);
      return { files: { speech: "speech.wav", background: "background.wav" }, latencyMs: 0, engine: "mf2", model: "fake" };
    }
    copyFileSync(m.wav48, `${m.out_dir}/out.wav`);
    return { files: { out: "out.wav" }, latencyMs: 0, engine: "dfn3", model: "fake" };
  },
};

// stands in for faulthandler.register(SIGUSR1) in the Python worker
process.on("SIGUSR1", () => process.stderr.write(`Current thread 0x1 (most recent call first):\n  File "fake.py", line 7 in ${role}_load\n`));

if (process.env.FAKE_HANG_START) await sleep(60_000);
send({ ready: true, role, pid: process.pid });
const rl = createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", (line) => {
  chain = chain.then(async () => {
    const m = JSON.parse(line);
    const fn = ops[m.op];
    if (!fn) return send({ id: m.id, ok: false, error: `unknown op ${m.op}`, retryable: false });
    try {
      send({ id: m.id, ok: true, result: await fn(m, m.id) });
    } catch (e) {
      send({ id: m.id, ok: false, error: String(e?.message ?? e), retryable: false });
    }
  });
});
rl.on("close", () => process.exit(0));
