import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { WorkerRole } from "./config.js";

// Long-lived Python model workers, JSON lines over stdio (docs/worker-protocol.md).
// One process per role, one request in flight per process; requests queue.

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

export interface WorkerRequestOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: number | null, message: string | null) => void;
}

interface Pending {
  id: number;
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  onProgress?: WorkerRequestOpts["onProgress"];
}

interface Logger {
  info: (o: unknown, msg?: string) => void;
  warn: (o: unknown, msg?: string) => void;
}

const silent: Logger = { info: () => {}, warn: () => {} };

export interface WorkerSpec {
  role: WorkerRole | string;
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  /** How long to wait for the `ready` line. */
  startTimeoutMs?: number;
  log?: Logger;
}

export class Worker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending: Pending | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private crashes: number[] = [];
  private stderrTail = "";
  private readonly log: Logger;
  pid: number | null = null;

  constructor(readonly spec: WorkerSpec) {
    this.log = spec.log ?? silent;
  }

  get alive(): boolean {
    return this.proc !== null;
  }

  /** Serialised request; spawns (or respawns after a crash) on demand. */
  request(op: string, params: Record<string, unknown> = {}, opts: WorkerRequestOpts = {}): Promise<Record<string, unknown>> {
    const run = this.chain.then(() => this.send(op, params, opts));
    this.chain = run.catch(() => {});
    return run;
  }

  private async send(op: string, params: Record<string, unknown>, opts: WorkerRequestOpts): Promise<Record<string, unknown>> {
    if (opts.signal?.aborted) throw new WorkerError("cancelled");
    await this.ensureStarted();
    const proc = this.proc!;
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (this.pending?.id === id) this.pending = null;
      };
      const onAbort = () => {
        // A worker cannot be interrupted mid-request: kill it, it restarts on demand.
        cleanup();
        this.kill("request cancelled");
        reject(new WorkerError("cancelled"));
      };
      this.pending = {
        id,
        onProgress: opts.onProgress,
        resolve: (v) => (cleanup(), resolve(v)),
        reject: (e) => (cleanup(), reject(e)),
      };
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          cleanup();
          this.kill(`timeout after ${opts.timeoutMs} ms`);
          reject(new WorkerError(`${this.spec.role} worker: ${op} timed out after ${opts.timeoutMs} ms`, true));
        }, opts.timeoutMs);
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      proc.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc && this.ready) return this.ready;
    // Crash-loop backoff: 3+ crashes in the last 30 s → wait before respawning.
    const t = Date.now();
    this.crashes = this.crashes.filter((c) => t - c < 30_000);
    if (this.crashes.length >= 3) {
      const wait = Math.min(10_000, 1000 * 2 ** (this.crashes.length - 3));
      this.log.warn({ role: this.spec.role, wait }, "worker crash loop, backing off");
      await new Promise((r) => setTimeout(r, wait));
    }
    this.ready = this.spawn();
    try {
      await this.ready;
    } catch (e) {
      this.ready = null;
      throw e;
    }
  }

  private spawn(): Promise<void> {
    const [cmd, ...args] = this.spec.command;
    const proc = spawn(cmd!, args, {
      cwd: this.spec.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1", ...this.spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.stderrTail = "";
    this.log.info({ role: this.spec.role, cmd: this.spec.command.join(" ") }, "worker spawn");

    return new Promise<void>((resolve, reject) => {
      let isReady = false;
      const startTimer = setTimeout(() => {
        if (!isReady) {
          this.kill("start timeout");
          reject(new WorkerError(`${this.spec.role} worker did not become ready`, true));
        }
      }, this.spec.startTimeoutMs ?? 120_000);

      proc.stderr.on("data", (b: Buffer) => {
        this.stderrTail = (this.stderrTail + b.toString()).slice(-4000);
      });
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.log.warn({ role: this.spec.role, line: line.slice(0, 300) }, "worker non-JSON stdout");
          return;
        }
        if (msg.ready === true && !isReady) {
          isReady = true;
          this.pid = typeof msg.pid === "number" ? msg.pid : (proc.pid ?? null);
          clearTimeout(startTimer);
          resolve();
          return;
        }
        const p = this.pending;
        if (!p || msg.id !== p.id) {
          this.log.warn({ role: this.spec.role, msg }, "worker message for unknown request");
          return;
        }
        if (msg.ok === true) p.resolve((msg.result as Record<string, unknown>) ?? {});
        else if (msg.ok === false) p.reject(new WorkerError(String(msg.error ?? "worker error"), msg.retryable === true));
        else if ("progress" in msg || "message" in msg) {
          p.onProgress?.(typeof msg.progress === "number" ? msg.progress : null, typeof msg.message === "string" ? msg.message : null);
        }
      });
      proc.on("error", (err) => {
        clearTimeout(startTimer);
        this.onExit(proc, `spawn error: ${err.message}`);
        if (!isReady) reject(new WorkerError(`${this.spec.role} worker failed to start: ${err.message}`));
      });
      proc.on("exit", (code, signal) => {
        clearTimeout(startTimer);
        const why = `exited code=${code} signal=${signal}`;
        this.onExit(proc, why);
        if (!isReady) reject(new WorkerError(`${this.spec.role} worker ${why} before ready: ${this.stderrTail.slice(-800)}`, true));
      });
    });
  }

  private onExit(proc: ChildProcessWithoutNullStreams, why: string): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.ready = null;
    this.pid = null;
    this.crashes.push(Date.now());
    this.log.warn({ role: this.spec.role, why, stderr: this.stderrTail.slice(-500) }, "worker exit");
    const p = this.pending;
    this.pending = null;
    p?.reject(new WorkerError(`${this.spec.role} worker crashed (${why}): ${this.stderrTail.slice(-800)}`, true));
  }

  kill(reason = "stop"): void {
    const proc = this.proc;
    if (!proc) return;
    this.log.info({ role: this.spec.role, reason }, "worker kill");
    this.proc = null;
    this.ready = null;
    this.pid = null;
    const p = this.pending;
    this.pending = null;
    p?.reject(new WorkerError(`${this.spec.role} worker killed: ${reason}`));
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, 3000).unref();
  }
}

export class WorkerManager {
  private workers = new Map<string, Worker>();

  constructor(
    private specs: Record<string, Omit<WorkerSpec, "role">>,
    private timeouts: Record<string, number> = {},
  ) {}

  get(role: string): Worker {
    let w = this.workers.get(role);
    if (!w) {
      const spec = this.specs[role];
      if (!spec) throw new WorkerError(`no worker configured for role ${role}`);
      w = new Worker({ role, ...spec });
      this.workers.set(role, w);
    }
    return w;
  }

  request(role: string, op: string, params: Record<string, unknown>, opts: WorkerRequestOpts = {}): Promise<Record<string, unknown>> {
    return this.get(role).request(op, params, { timeoutMs: this.timeouts[role], ...opts });
  }

  stopAll(): void {
    for (const w of this.workers.values()) w.kill("shutdown");
  }
}
