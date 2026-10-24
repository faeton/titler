import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDb } from "../src/db.js";
import { Scheduler } from "../src/jobs.js";
import { Store } from "../src/store.js";
import { Worker } from "../src/workers.js";
import { FAKE_WORKER, rmDir, tmpDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(rmDir));

const setup = () => {
  const dir = tmpDir();
  dirs.push(dir);
  const path = join(dir, "titler.db");
  const db = openDb(path);
  const store = new Store(db);
  const p = store.createProject({ name: "x", sourceSha256: "abc", sourceName: "x.mov", sourcePath: "sources/abc.mov" });
  return { dir, path, db, store, p };
};

const waitFor = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("db", () => {
  it("migrates once and records user_version", () => {
    const { db } = setup();
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    expect(migrate(db)).toBe(1); // idempotent
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(["artifacts", "hypotheses", "jobs", "projects", "transcript_revs", "uploads"]);
  });

  it("revisions are append-only and bump the project pointer", () => {
    const { store, p } = setup();
    store.addRevision(p.id, { paragraphs: [] }, "asr");
    store.addRevision(p.id, { paragraphs: [] }, "user");
    expect(store.latestRevision(p.id)?.rev).toBe(2);
    expect(store.getProject(p.id)?.transcriptRev).toBe(2);
    expect(store.actorsAfter(p.id, 1)).toEqual(["user"]);
  });
});

describe("scheduler", () => {
  it("runs jobs per resource class with concurrency limits", async () => {
    const { store, p } = setup();
    const s = new Scheduler(store, { media: 2, asr: 1 });
    let media = 0;
    let maxMedia = 0;
    let asrRunning = 0;
    let maxAsr = 0;
    s.register("ingest", async () => {
      maxMedia = Math.max(maxMedia, ++media);
      await new Promise((r) => setTimeout(r, 50));
      media--;
      return { ok: 1 };
    });
    s.register("asr", async (ctx) => {
      maxAsr = Math.max(maxAsr, ++asrRunning);
      ctx.progress(0.5, "half");
      await new Promise((r) => setTimeout(r, 30));
      asrRunning--;
    });
    s.start();
    const ids = [...Array(5)].map(() => s.enqueue(p.id, "ingest").id);
    ids.push(...[...Array(3)].map(() => s.enqueue(p.id, "asr").id));
    await s.idle();
    expect(maxMedia).toBe(2);
    expect(maxAsr).toBe(1);
    for (const id of ids) expect(store.getJob(id)?.status).toBe("done");
    expect(store.getJob(ids[0]!)?.result).toEqual({ ok: 1 });
    expect(store.getJob(ids[0]!)?.progress).toBe(1);
  });

  it("higher priority jumps the queue", async () => {
    const { store, p } = setup();
    const s = new Scheduler(store, { align: 1 });
    const order: string[] = [];
    s.register("align", async (ctx) => {
      order.push(String(ctx.job.params.n));
    });
    const a = s.enqueue(p.id, "align", { n: "low1" });
    s.enqueue(p.id, "align", { n: "low2" });
    s.enqueue(p.id, "align", { n: "high" }, { priority: 10 });
    expect(a.status).toBe("queued");
    s.start();
    await s.idle();
    expect(order).toEqual(["high", "low1", "low2"]);
  });

  it("re-queues jobs left running by a crashed process and runs them again", async () => {
    const { path, store, p } = setup();
    // Process 1: picks the job up and "dies" mid-run (never stopped).
    const s1 = new Scheduler(store, { media: 1 });
    let started1 = false;
    s1.register("ingest", () => {
      started1 = true;
      return new Promise(() => {}); // hangs forever
    });
    s1.start();
    const job = s1.enqueue(p.id, "ingest", { x: 1 });
    await waitFor(() => started1);
    expect(store.getJob(job.id)?.status).toBe("running");
    s1.pause();

    // Process 2: a fresh connection on the same DB file.
    const store2 = new Store(openDb(path));
    const s2 = new Scheduler(store2, { media: 1 });
    const seen: unknown[] = [];
    s2.register("ingest", async (ctx) => {
      seen.push(ctx.job.params);
      return { second: true };
    });
    expect(s2.start()).toBe(1);
    await s2.idle();
    const after = store2.getJob(job.id)!;
    expect(after.status).toBe("done");
    expect(after.attempts).toBe(2);
    expect(seen).toEqual([{ x: 1 }]);
  });

  it("cancels queued and running jobs", async () => {
    const { store, p } = setup();
    const s = new Scheduler(store, { media: 1 });
    let started = false;
    s.register("render", (ctx) => {
      started = true;
      return new Promise((_res, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    });
    s.start();
    const running = s.enqueue(p.id, "render");
    const queued = s.enqueue(p.id, "render");
    await waitFor(() => started);
    expect(s.cancel(queued.id)?.status).toBe("cancelled");
    s.cancel(running.id);
    await s.idle();
    expect(store.getJob(running.id)?.status).toBe("cancelled");
    expect(store.getJob(queued.id)?.status).toBe("cancelled");
  });

  it("records handler errors", async () => {
    const { store, p } = setup();
    const s = new Scheduler(store, { analyze: 1 });
    s.register("analyze", async () => {
      throw new Error("boom");
    });
    s.start();
    const j = s.enqueue(p.id, "analyze");
    await s.idle();
    expect(store.getJob(j.id)).toMatchObject({ status: "error", error: "boom" });
  });
});

describe("worker manager", () => {
  const spec = (extra: Record<string, string> = {}) => ({
    role: "asr",
    command: ["/usr/bin/env", ...Object.entries(extra).map(([k, v]) => `${k}=${v}`), process.execPath, FAKE_WORKER, "--role", "asr"],
    cwd: process.cwd(),
  });

  it("matches responses, forwards progress, serialises requests", async () => {
    const w = new Worker(spec());
    const progress: unknown[] = [];
    const [a, b] = await Promise.all([
      w.request("echo", { value: 1 }, { onProgress: (p, m) => progress.push([p, m]) }),
      w.request("echo", { value: 2 }),
    ]);
    expect(a).toEqual({ echo: 1 });
    expect(b).toEqual({ echo: 2 });
    expect(progress).toEqual([[0.5, "half"]]);
    await expect(w.request("nope")).rejects.toThrow(/unknown op/);
    w.kill();
  });

  it("restarts after a crash", async () => {
    const w = new Worker(spec());
    await w.request("ping");
    const pid1 = w.pid;
    await expect(w.request("crash")).rejects.toThrow(/crashed/);
    expect(w.alive).toBe(false);
    expect(await w.request("ping")).toMatchObject({ role: "asr" });
    expect(w.pid).not.toBe(pid1);
    w.kill();
  });

  it("times out and cancels by killing the process", async () => {
    const w = new Worker(spec());
    await expect(w.request("sleep", { ms: 5000 }, { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    const ac = new AbortController();
    const pending = w.request("sleep", { ms: 5000 }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(await w.request("ping")).toMatchObject({ role: "asr" });
    w.kill();
  });
});
