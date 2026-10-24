import { spawn } from "node:child_process";

export interface RunOpts {
  signal?: AbortSignal;
  /** Total duration (ms) of the output, for progress from `-progress pipe:1`. */
  durationMs?: number;
  onProgress?: (fraction: number) => void;
  env?: Record<string, string>;
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

/** Run a process, collect stdout/stderr; reject on non-zero exit or abort. */
export const run = (cmd: string, args: string[], opts: RunOpts = {}): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new ProcessError("cancelled", ""));
    const proc = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buf = "";
    proc.stdout.on("data", (b: Buffer) => {
      const s = b.toString();
      if (!opts.onProgress) {
        stdout += s;
        return;
      }
      buf += s;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        // out_time_us (out_time_ms is also µs in ffmpeg, a historic misnomer).
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && opts.durationMs) opts.onProgress(Math.min(1, Number(m[1]) / 1000 / opts.durationMs));
      }
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-20_000);
    });
    const onAbort = () => proc.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    proc.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new ProcessError(`${cmd}: ${e.message}`, stderr));
    });
    proc.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new ProcessError("cancelled", stderr));
      if (code !== 0) return reject(new ProcessError(`${cmd.split("/").pop()} exited ${code}: ${stderr.slice(-1500)}`, stderr));
      resolve({ stdout, stderr });
    });
  });
