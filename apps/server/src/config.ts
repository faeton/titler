import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export type WorkerRole = "analyze" | "asr" | "align" | "enhance";

export interface Config {
  repoRoot: string;
  dataDir: string;
  host: string;
  port: number;
  ffmpeg: string;
  /** VAAPI-capable ffmpeg wrapper; null when VAAPI is unavailable/disabled. */
  ffmpegHw: string | null;
  ffprobe: string;
  vaapiDevice: string;
  fontsDir: string;
  webDist: string;
  workers: Record<WorkerRole, string[]>;
  workerEnv: Record<string, string>;
  /** Per-request worker timeout (ms) per role. */
  workerTimeoutMs: Record<WorkerRole, number>;
  concurrency: Record<string, number>;
  asrProvider: string;
  logLevel: string;
}

const home = homedir();

const canUse = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const workerCmd = (env: string | undefined, venv: string, role: WorkerRole, root: string): string[] => {
  if (env) {
    const parsed = JSON.parse(env) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string") || !parsed.length) {
      throw new Error(`worker command for ${role} must be a non-empty JSON string array`);
    }
    return parsed;
  }
  return [resolve(root, "bench/envs", venv, "bin/python"), "-m", "titler_worker", "--role", role];
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config => {
  const repoRoot = overrides.repoRoot ?? REPO_ROOT;
  const vaapiDevice = env.TITLER_VAAPI_DEVICE ?? "/dev/dri/renderD128";
  const hwPath = env.TITLER_FFMPEG_HW ?? resolve(home, ".local/bin/ffmpeg-hw");
  const hwOk = env.TITLER_VAAPI !== "0" && existsSync(hwPath) && canUse(vaapiDevice);
  const localFf = (name: string) => {
    const p = resolve(home, ".local/bin", name);
    return existsSync(p) ? p : name;
  };
  const cfg: Config = {
    repoRoot,
    dataDir: resolve(env.TITLER_DATA ?? resolve(repoRoot, "data")),
    host: env.TITLER_HOST ?? "127.0.0.1",
    port: Number(env.TITLER_PORT ?? 8772),
    ffmpeg: env.TITLER_FFMPEG ?? localFf("ffmpeg"),
    ffmpegHw: hwOk ? hwPath : null,
    ffprobe: env.TITLER_FFPROBE ?? localFf("ffprobe"),
    vaapiDevice,
    fontsDir: resolve(repoRoot, "assets/fonts"),
    webDist: resolve(repoRoot, "apps/web/dist"),
    workers: {
      analyze: workerCmd(env.TITLER_WORKER_ANALYZE, "align-main", "analyze", repoRoot),
      asr: workerCmd(env.TITLER_WORKER_ASR, "asr-fw", "asr", repoRoot),
      align: workerCmd(env.TITLER_WORKER_ALIGN, "align-main", "align", repoRoot),
      enhance: workerCmd(env.TITLER_WORKER_ENHANCE, "enh-cv", "enhance", repoRoot),
    },
    workerEnv: { PYTHONPATH: resolve(repoRoot, "workers") },
    workerTimeoutMs: {
      analyze: Number(env.TITLER_TIMEOUT_ANALYZE ?? 10 * 60_000),
      asr: Number(env.TITLER_TIMEOUT_ASR ?? 60 * 60_000),
      align: Number(env.TITLER_TIMEOUT_ALIGN ?? 10 * 60_000),
      enhance: Number(env.TITLER_TIMEOUT_ENHANCE ?? 60 * 60_000),
    },
    concurrency: { media: 2, asr: 1, align: 1, enhance: 1, analyze: 1 },
    asrProvider: env.TITLER_ASR_PROVIDER ?? "faster-whisper",
    logLevel: env.TITLER_LOG_LEVEL ?? "info",
  };
  return { ...cfg, ...overrides };
};
