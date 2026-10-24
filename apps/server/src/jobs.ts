import type { JobKind } from "@titler/core";
import type { JobRow, Store } from "./store.js";

// One in-process scheduler over the SQLite jobs table. Jobs are rows; the
// scheduler picks queued rows per resource class up to its concurrency.
// Restart = rows left `running` go back to `queued` (see Store.requeueRunning).

export const RESOURCE_CLASS: Record<JobKind, string> = {
  ingest: "media",
  render: "media",
  compare: "enhance",
  enhance: "enhance",
  analyze: "analyze",
  asr: "asr",
  align: "align",
};

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export interface JobContext {
  job: JobRow;
  signal: AbortSignal;
  progress: (p: number | null, message?: string | null) => void;
  throwIfCancelled: () => void;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

export interface EnqueueOpts {
  priority?: number;
}

export class Scheduler {
  private handlers = new Map<JobKind, JobHandler>();
  private running = new Map<string, { controller: AbortController; promise: Promise<void>; cls: string }>();
  private started = false;
  private pumping = false;
  private repump = false;
  private lastProgressWrite = new Map<string, number>();
  onError: (job: JobRow, err: unknown) => void = () => {};

  constructor(
    private store: Store,
    private concurrency: Record<string, number>,
  ) {}

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Re-queue rows orphaned by a previous process and start picking jobs. */
  start(): number {
    const n = this.store.requeueRunning();
    this.started = true;
    this.pump();
    return n;
  }

  enqueue(projectId: string, kind: JobKind, params: Record<string, unknown> = {}, opts: EnqueueOpts = {}): JobRow {
    const job = this.store.createJob({ projectId, kind, resourceClass: RESOURCE_CLASS[kind], params, priority: opts.priority });
    this.pump();
    return job;
  }

  cancel(id: string): JobRow | null {
    const job = this.store.getJob(id);
    if (!job) return null;
    if (job.status === "queued") this.store.cancelQueued(id);
    else if (job.status === "running") this.running.get(id)?.controller.abort();
    return this.store.getJob(id);
  }

  /** Cancel all active jobs of a project and wait for running ones to stop. */
  async cancelProject(projectId: string): Promise<void> {
    const active = this.store.listJobs({ projectId, active: true });
    for (const j of active) this.cancel(j.id);
    await Promise.all(active.map((j) => this.running.get(j.id)?.promise));
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Resolve when no job is running or queued (tests / shutdown). */
  async idle(timeoutMs = 30_000): Promise<void> {
    const t0 = Date.now();
    while (this.running.size || this.store.listJobs({ active: true }).some((j) => this.handlers.has(j.kind))) {
      if (Date.now() - t0 > timeoutMs) throw new Error("scheduler idle timeout");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    const all = [...this.running.values()];
    for (const r of all) r.controller.abort();
    await Promise.allSettled(all.map((r) => r.promise));
  }

  /** Stop picking new jobs; running ones finish (or are re-queued on next start). */
  pause(): void {
    this.started = false;
  }

  pump(): void {
    if (!this.started) return;
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        for (const cls of this.store.queuedClasses()) {
          const limit = this.concurrency[cls] ?? 1;
          while ([...this.running.values()].filter((r) => r.cls === cls).length < limit) {
            const job = this.store.nextQueued(cls, new Set(this.running.keys()));
            if (!job) break;
            const handler = this.handlers.get(job.kind);
            if (!handler) {
              this.store.markRunning(job.id);
              this.store.finishJob(job.id, "error", { error: `no handler for job kind ${job.kind}` });
              continue;
            }
            if (!this.store.markRunning(job.id)) continue;
            this.launch({ ...job, status: "running" }, handler);
          }
        }
      } while (this.repump);
    } finally {
      this.pumping = false;
    }
  }

  private launch(job: JobRow, handler: JobHandler): void {
    const controller = new AbortController();
    const ctx: JobContext = {
      job,
      signal: controller.signal,
      progress: (p, message = null) => {
        // Throttle DB writes; the UI polls.
        const t = Date.now();
        const last = this.lastProgressWrite.get(job.id) ?? 0;
        if (message === null && t - last < 250 && p !== 1) return;
        this.lastProgressWrite.set(job.id, t);
        this.store.updateJobProgress(job.id, p === null ? null : Math.max(0, Math.min(1, p)), message);
      },
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new CancelledError();
      },
    };
    const promise = (async () => {
      try {
        const result = await handler(ctx);
        if (controller.signal.aborted) {
          if (this.started) this.store.finishJob(job.id, "cancelled", {});
        } else this.store.finishJob(job.id, "done", { result: result ?? {} });
      } catch (err) {
        if (!this.started && controller.signal.aborted) {
          // Shutdown: leave the row running; next start re-queues it.
        } else if (controller.signal.aborted || err instanceof CancelledError) {
          this.store.finishJob(job.id, "cancelled", {});
        } else {
          this.onError(job, err);
          this.store.finishJob(job.id, "error", { error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        this.running.delete(job.id);
        this.lastProgressWrite.delete(job.id);
        // Let follow-up enqueues settle, then pick more work.
        setImmediate(() => this.pump());
      }
    })();
    this.running.set(job.id, { controller, promise, cls: job.resourceClass });
  }
}
