import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, type BuildOpts } from "../src/app.js";
import type { Config } from "../src/config.js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_WORKER = resolve(HERE, "fake-worker.mjs");
const SCRATCH = process.env.TITLER_TEST_TMP ?? (existsSync("/mnt/flash/scratch/tmp") ? "/mnt/flash/scratch/tmp" : tmpdir());

export const tmpDir = (prefix = "titler-test-"): string => mkdtempSync(join(SCRATCH, prefix));
export const rmDir = (d: string) => rmSync(d, { recursive: true, force: true });

export const fakeWorkers = (env: Record<string, string> = {}): Config["workers"] => {
  const cmd = (role: string) => ["/usr/bin/env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, FAKE_WORKER, "--role", role];
  return { analyze: cmd("analyze"), asr: cmd("asr"), align: cmd("align"), enhance: cmd("enhance") };
};

export const testApp = async (dataDir: string, opts: BuildOpts & { workerEnv?: Record<string, string> } = {}) =>
  buildApp({
    logger: false,
    ...opts,
    config: { dataDir, workers: fakeWorkers(opts.workerEnv), ...opts.config },
  });

const ffmpeg = process.env.TITLER_FFMPEG ?? (existsSync(`${process.env.HOME}/.local/bin/ffmpeg`) ? `${process.env.HOME}/.local/bin/ffmpeg` : "ffmpeg");

/** Small synthetic clip: 640x360 test pattern + 440 Hz tone. */
export const makeClip = (path: string, seconds = 2, extra: string[] = []): string => {
  execFileSync(ffmpeg, [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=f=440:r=48000:d=${seconds}`,
    ...extra,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
  ]);
  return path;
};
