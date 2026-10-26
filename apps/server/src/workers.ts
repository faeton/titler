import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { WorkerRole } from "./config.js";

// Long-lived Python model workers, JSON lines over stdio (docs/worker-protocol.md).
// One process per role, one request in flight per process; requests queue.
//
// Hang watchdog: a worker that prints no protocol line for too long while starting or
// loading a model (or, if configured, during any request) gets SIGUSR1 (the Python worker
// dumps every thread's stack to stderr via faulthandler), the dump goes to the server log,
// the worker is killed and the request is retried once on a fresh process. A second hang
// fails the request.

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

type HangPhase = "start" | "load" | "request";
const PHASE_TEXT: Record<HangPhase, string> = { start: "starting", load: "loading a model", request: "running a request" };

/** The worker went silent past the watchdog limit (its stack dump is in `dump` and the log). */
/** Signal the worker's process group (its ffmpeg / deep-filter children too), else just the worker. */
const signalGroup = (proc: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): void => {
  try {
    if (proc.pid && process.platform !== "win32") process.kill(-proc.pid, sig);
    else proc.kill(sig);
  } catch {
    // ESRCH: the whole group is gone. Otherwise fall back to the worker itself (no-op if it exited).
    if (proc.exitCode === null && proc.signalCode === null) proc.kill(sig);
  }
};

export class WorkerHangError extends WorkerError {
  constructor(
    message: string,
    readonly phase: HangPhase,
    readonly dump: string,
  ) {
    super(message, true);
    this.name = "WorkerHangError";
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
  /** The last progress line said "loading…": the load limit of the watchdog applies. */
  loading: boolean;
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
  /** How long to wait for the `ready` line (default: `loadSilenceMs`). */
  startTimeoutMs?: number;
  /** Watchdog: no line for this long while a model loads (a "loading…" progress line) → hang. Default 120 s. */
  loadSilenceMs?: number;
  /** Watchdog for the rest of a request; 0 / unset = off (requests still have `timeoutMs`). */
  silenceMs?: number;
  /** Upper bound for collecting the SIGUSR1 stack dump before the kill. */
  dumpWaitMs?: number;
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
  /** Re-arms the current process's watchdog (after a line, or when a request starts or ends). */
  private rearm: () => void = () => {};
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

  /** One attempt, and one more on a fresh process if the first hung. */
  private async send(op: string, params: Record<string, unknown>, opts: WorkerRequestOpts): Promise<Record<string, unknown>> {
    try {
      return await this.attempt(op, params, opts);
    } catch (e) {
      if (!(e instanceof WorkerHangError) || opts.signal?.aborted) throw e;
      this.log.warn({ role: this.spec.role, op, phase: e.phase }, "worker hung, restarting it once");
    }
    try {
      return await this.attempt(op, params, opts);
    } catch (e) {
      if (!(e instanceof WorkerHangError)) throw e;
      // faulthandler runs in the main thread ("Current thread"): its innermost frame is where the load is stuck.
      const main = e.dump.slice(Math.max(0, e.dump.indexOf("Current thread")));
      const at = /^\s*File .*$/m.exec(main)?.[0].trim();
      throw new WorkerError(
        `${this.spec.role} worker hung twice while ${PHASE_TEXT[e.phase]} (op ${op}); stack dumps are in the server log` +
          (at ? `; innermost frame: ${at}` : ""),
      );
    }
  }

  private async attempt(op: string, params: Record<string, unknown>, opts: WorkerRequestOpts): Promise<Record<string, unknown>> {
    if (opts.signal?.aborted) throw new WorkerError("cancelled");
    await this.ensureStarted();
    const proc = this.proc!;
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (this.pending?.id === id) {
          this.pending = null;
          this.rearm();
        }
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
        loading: false,
        resolve: (v) => (cleanup(), resolve(v)),
        reject: (e) => (cleanup(), reject(e)),
      };
      this.rearm();
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
      // Own process group, so kill() also reaches ffmpeg / deep-filter children (see kill()).
      detached: process.platform !== "win32",
    });
    this.proc = proc;
    this.stderrTail = "";
    this.log.info({ role: this.spec.role, cmd: this.spec.command.join(" ") }, "worker spawn");

    return new Promise<void>((resolve, reject) => {
      let isReady = false;
      // Every stdout line bumps this; hang() compares it after the dump wait, so a worker
      // that answered in the meantime (ready, result, progress) isn't killed.
      let lines = 0;
      const loadMs = this.spec.loadSilenceMs ?? 120_000;
      const limits: Record<HangPhase, number> = {
        start: this.spec.startTimeoutMs ?? loadMs,
        load: loadMs,
        request: this.spec.silenceMs ?? 0,
      };
      let watchdog: NodeJS.Timeout | undefined;
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = undefined;
        if (this.proc !== proc) return;
        const phase: HangPhase | null = !isReady ? "start" : this.pending ? (this.pending.loading ? "load" : "request") : null;
        if (!phase || !limits[phase]) return;
        watchdog = setTimeout(() => {
          const seen = lines;
          void this.hang(proc, phase, limits[phase], () => lines !== seen, isReady ? undefined : reject);
        }, limits[phase]);
      };
      this.rearm = arm;
      arm();

      proc.stderr.on("data", (b: Buffer) => {
        this.stderrTail = (this.stderrTail + b.toString()).slice(-4000);
      });
      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        lines++;
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
          arm();
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
          const text = typeof msg.message === "string" ? msg.message : null;
          p.loading = text !== null && /^loading\b/i.test(text);
          arm();
          p.onProgress?.(typeof msg.progress === "number" ? msg.progress : null, text);
        }
      });
      proc.on("error", (err) => {
        clearTimeout(watchdog);
        this.onExit(proc, `spawn error: ${err.message}`);
        if (!isReady) reject(new WorkerError(`${this.spec.role} worker failed to start: ${err.message}`));
      });
      proc.on("exit", (code, signal) => {
        clearTimeout(watchdog);
        const why = `exited code=${code} signal=${signal}`;
        this.onExit(proc, why);
        if (!isReady) reject(new WorkerError(`${this.spec.role} worker ${why} before ready: ${this.stderrTail.slice(-800)}`, true));
      });
    });
  }

  /** Watchdog fired: SIGUSR1 for a stack dump, log it, kill, fail the request (or the start). */
  private async hang(
    proc: ChildProcessWithoutNullStreams,
    phase: HangPhase,
    silentMs: number,
    answered: () => boolean,
    rejectStart?: (e: Error) => void,
  ): Promise<void> {
    if (this.proc !== proc) return;
    const { role } = this.spec;
    this.log.warn({ role, pid: proc.pid, phase, silentMs }, "worker silent, asking for a stack dump (SIGUSR1)");
    let dump = "";
    const onData = (b: Buffer) => void (dump += b.toString());
    proc.stderr.on("data", onData);
    try {
      proc.kill("SIGUSR1");
    } catch {
      // already gone: the exit handler takes over
    }
    // faulthandler writes the dump in one go; stop once stderr has been quiet for 200 ms.
    const t0 = Date.now();
    const limit = this.spec.dumpWaitMs ?? 2000;
    let seen = 0;
    let quietSince = t0;
    while (Date.now() - t0 < limit && !(dump && Date.now() - quietSince > 200)) {
      await new Promise((r) => setTimeout(r, 50));
      if (dump.length !== seen) (seen = dump.length), (quietSince = Date.now());
    }
    proc.stderr.off("data", onData);
    dump = dump.slice(-16_000);
    this.log.warn({ role, pid: proc.pid, phase, stack: dump || "(no dump: the worker did not answer SIGUSR1)" }, "worker hang: stack dump");
    if (this.proc !== proc) return; // exited or was killed while we waited
    if (answered()) {
      // It spoke during the dump wait: slow, not hung. The current request (maybe a new one) keeps going.
      this.log.warn({ role, pid: proc.pid, phase }, "worker answered during the stack dump, not killing it");
      this.rearm();
      return;
    }
    const err = new WorkerHangError(
      `${role} worker silent for ${silentMs} ms while ${PHASE_TEXT[phase]}` +
        (phase === "request" ? "" : " (raise TITLER_WORKER_LOAD_SILENCE_MS if loads are just slow here)"),
      phase,
      dump,
    );
    const p = this.pending;
    this.pending = null;
    this.kill(`hang while ${PHASE_TEXT[phase]}`);
    p?.reject(err);
    rejectStart?.(err);
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
    signalGroup(proc, "SIGTERM");
    // Always escalate for the group: the worker may have exited on SIGTERM while a child
    // (ffmpeg, deep-filter) ignored it. A group that's already gone is a no-op.
    setTimeout(() => signalGroup(proc, "SIGKILL"), 3000).unref();
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
