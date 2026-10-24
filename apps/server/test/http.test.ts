import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toEditedParagraphs, type ProjectView, type SaveTranscriptRes, type TranscriptRevision, type UploadState } from "@titler/core";
import type { App } from "../src/app.js";
import { makeClip, rmDir, testApp, tmpDir } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const start = async (opts: Parameters<typeof testApp>[1] = {}) => {
  const dir = tmpDir();
  const app = await testApp(dir, { config: { ffmpegHw: null }, ...opts });
  cleanups.push(() => rmDir(dir));
  cleanups.push(() => app.close());
  return { dir, app };
};

const api = async <T>(app: App, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.fastify.inject({
    method: method as "GET",
    url,
    ...(body instanceof Buffer ? { payload: body, headers: { "content-type": "application/octet-stream", ...headers } } : body !== undefined ? { payload: body as object, headers } : { headers }),
  });
  return { status: res.statusCode, json: (res.body ? (() => { try { return JSON.parse(res.body); } catch { return res.body; } })() : null) as T, raw: res };
};

const upload = async (app: App, bytes: Buffer, name: string, chunk = 64 * 1024): Promise<ProjectView> => {
  const u = await api<UploadState>(app, "POST", "/api/uploads", { name, size: bytes.length });
  expect(u.status).toBe(200);
  for (let off = 0; off < bytes.length; off += chunk) {
    const r = await api<UploadState>(app, "PUT", `/api/uploads/${u.json.id}?offset=${off}`, bytes.subarray(off, off + chunk));
    expect(r.status).toBe(200);
  }
  const done = await api<ProjectView>(app, "POST", `/api/uploads/${u.json.id}/complete`);
  expect(done.status).toBe(200);
  return done.json;
};

const waitJobs = async (app: App, projectId: string, ms = 60_000): Promise<ProjectView> => {
  const t0 = Date.now();
  for (;;) {
    const v = (await api<ProjectView>(app, "GET", `/api/projects/${projectId}`)).json;
    if (!v.jobs.some((j) => j.status === "queued" || j.status === "running")) return v;
    if (Date.now() - t0 > ms) throw new Error("jobs did not finish: " + JSON.stringify(v.jobs.map((j) => [j.kind, j.status, j.message])));
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("uploads", () => {
  it("resumes from `received` and rejects a wrong offset", async () => {
    const { app, dir } = await start({ noScheduler: true });
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    const u = (await api<UploadState>(app, "POST", "/api/uploads", { name: "clip.mov", size: bytes.length })).json;
    expect(u.received).toBe(0);
    await api(app, "PUT", `/api/uploads/${u.id}?offset=0`, bytes.subarray(0, 100_000));
    // Client lost track and retries from 0: told where to resume.
    const bad = await api<{ error: string; received: number }>(app, "PUT", `/api/uploads/${u.id}?offset=0`, bytes.subarray(0, 100_000));
    expect(bad.status).toBe(409);
    expect(bad.json.received).toBe(100_000);
    const state = (await api<UploadState>(app, "GET", `/api/uploads/${u.id}`)).json;
    expect(state).toMatchObject({ id: u.id, name: "clip.mov", size: 300_000, received: 100_000 });
    // Can't complete early.
    expect((await api(app, "POST", `/api/uploads/${u.id}/complete`)).status).toBe(409);
    // Overflow beyond declared size is refused.
    expect((await api(app, "PUT", `/api/uploads/${u.id}?offset=100000`, Buffer.alloc(250_000))).status).toBe(400);
    expect((await api<UploadState>(app, "GET", `/api/uploads/${u.id}`)).json.received).toBe(100_000);
    await api(app, "PUT", `/api/uploads/${u.id}?offset=100000`, bytes.subarray(100_000));
    const view = (await api<ProjectView>(app, "POST", `/api/uploads/${u.id}/complete`)).json;
    expect(view.project.name).toBe("clip");
    expect(view.project.sourceName).toBe("clip.mov");
    expect(view.jobs.map((j) => [j.kind, j.status])).toEqual([["ingest", "queued"]]);
    const src = readFileSync(join(dir, "sources", `${view.project.sourceSha256}.mov`));
    expect(src.equals(bytes)).toBe(true);
    // Source served with Range support.
    const r = await app.fastify.inject({ method: "GET", url: `/api/projects/${view.project.id}/source`, headers: { range: "bytes=10-19" } });
    expect(r.statusCode).toBe(206);
    expect(r.headers["content-range"]).toBe("bytes 10-19/300000");
    expect(Buffer.from(r.rawPayload).equals(bytes.subarray(10, 20))).toBe(true);
  });

  it("dedupes identical bytes to the existing project", async () => {
    const { app } = await start({ noScheduler: true });
    const bytes = Buffer.from("same bytes ".repeat(5000));
    const a = await upload(app, bytes, "a.mp4");
    const b = await upload(app, bytes, "b.mp4");
    expect(b.project.id).toBe(a.project.id);
    expect(b.jobs.filter((j) => j.kind === "ingest")).toHaveLength(1);
    const list = (await api<unknown[]>(app, "GET", "/api/projects")).json;
    expect(list).toHaveLength(1);
  });
});

describe("pipeline with fake workers", () => {
  it("ingest → analyze + seeded asr → edit → align → render", async () => {
    const { app, dir } = await start();
    const clip = makeClip(join(dir, "clip.mp4"), 3);
    const created = await upload(app, readFileSync(clip), "clip.mp4", 256 * 1024);
    const v = await waitJobs(app, created.project.id);
    expect(v.jobs.map((j) => `${j.kind}:${j.status}`).sort()).toEqual(["analyze:done", "asr:done", "compare:done", "ingest:done"]);
    expect(v.project.probe).toMatchObject({ width: 640, height: 360, rotation: 0, audioCodec: "aac" });
    expect(v.urls.proxy).toMatch(/^\/api\/artifacts\/[0-9a-f]{64}\/proxy\.mp4$/);
    expect(v.urls.peaks).toBeTruthy();
    expect(v.urls.vad).toBeTruthy();
    expect([...new Set(v.artifacts.map((a) => a.kind))].sort()).toEqual(["audio_variant", "compare_clip", "peaks", "proxy", "vad", "wav16", "wav48"]);
    expect(v.transcript?.rev).toBe(1);
    expect(v.transcript?.actor).toBe("asr");
    expect(v.hypotheses).toHaveLength(1);
    const proxy = await app.fastify.inject({ method: "GET", url: v.urls.proxy!, headers: { range: "bytes=0-99" } });
    expect(proxy.statusCode).toBe(206);
    expect(proxy.headers["content-type"]).toBe("video/mp4");

    // Insert a missing word: "я приехал Самоа." → "я приехал на Самоа."
    const t1 = v.transcript!;
    const paras = toEditedParagraphs(t1.doc);
    paras[0]!.runs.splice(4, 0, { text: "на ", wordId: null });
    const saved = await api<SaveTranscriptRes>(app, "PUT", `/api/projects/${v.project.id}/transcript`, { baseRev: 1, paragraphs: paras });
    expect(saved.status).toBe(200);
    expect(saved.json.revision.rev).toBe(2);
    expect(saved.json.changed).toHaveLength(1);
    expect(saved.json.alignJobId).toBeTruthy();
    const after = await waitJobs(app, v.project.id);
    expect(after.transcript?.rev).toBe(3);
    expect(after.transcript?.actor).toBe("align");
    const na = after.transcript!.doc.paragraphs[0]!.words.find((w) => w.text === "на")!;
    expect(na.timing).toBe("aligned");
    expect(na.start).not.toBeNull();

    // A save based on rev 2 is still accepted: only the aligner wrote since.
    const p2 = toEditedParagraphs(saved.json.revision.doc);
    p2[0]!.runs[0] = { text: "Я", wordId: p2[0]!.runs[0]!.wordId };
    const s2 = await api<SaveTranscriptRes>(app, "PUT", `/api/projects/${v.project.id}/transcript`, { baseRev: 2, paragraphs: p2 });
    expect(s2.status).toBe(200);
    // ...and keeps the aligned timing of "на" from rev 3.
    expect(s2.json.revision.doc.paragraphs[0]!.words.find((w) => w.text === "на")!.timing).toBe("aligned");
    await waitJobs(app, v.project.id);
    // But a save based on rev 1 now conflicts with a user edit.
    const stale = await api<{ error: string; current: TranscriptRevision }>(app, "PUT", `/api/projects/${v.project.id}/transcript`, { baseRev: 1, paragraphs: paras });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("stale");
    expect(stale.json.current.rev).toBeGreaterThanOrEqual(4);

    // Ops: manual timing + hide.
    const cur = (await api<TranscriptRevision>(app, "GET", `/api/projects/${v.project.id}/transcript`)).json;
    const w0 = cur.doc.paragraphs[0]!.words[0]!;
    const ops = await api<SaveTranscriptRes>(app, "POST", `/api/projects/${v.project.id}/transcript/ops`, {
      baseRev: cur.rev,
      ops: [
        { kind: "set_timing", wordId: w0.id, start: 50, end: 290 },
        { kind: "set_hidden", wordIds: [w0.id], hidden: true },
      ],
    });
    expect(ops.status).toBe(200);
    expect(ops.json.revision.doc.paragraphs[0]!.words[0]).toMatchObject({ start: 50, end: 290, timing: "manual", hidden: true });
    expect((await api(app, "POST", `/api/projects/${v.project.id}/transcript/ops`, { baseRev: ops.json.revision.rev, ops: [{ kind: "set_timing", wordId: "nope", start: 1, end: 2 }] })).status).toBe(400);
    const revs = (await api<{ rev: number; actor: string }[]>(app, "GET", `/api/projects/${v.project.id}/transcript/revisions`)).json;
    expect(revs.map((r) => r.actor).slice(0, 3)).toEqual(["asr", "user", "align"]);

    // Render captioned + clean + subs (libx264 here; VAAPI is exercised by the e2e script).
    const job = await api<{ id: string }>(app, "POST", `/api/projects/${v.project.id}/render`, { outputs: ["captioned", "clean", "srt", "vtt"] });
    expect(job.status).toBe(200);
    const fin = await waitJobs(app, v.project.id, 120_000);
    const rj = fin.jobs.find((j) => j.id === job.json.id)!;
    expect(rj.status, rj.error ?? "").toBe("done");
    const outs = rj.result!.outputs as Record<string, string>;
    expect(Object.keys(outs).sort()).toEqual(["captioned", "clean", "srt", "vtt"]);
    expect(outs.captioned).toMatch(/\/\d{8}_\d{6}_bold_[0-9a-f]{8}\.mp4$/);
    expect(outs.clean).toMatch(/_clean_[0-9a-f]{8}\.mp4$/);
    const srt = await app.fastify.inject({ method: "GET", url: outs.srt! });
    expect(srt.body).toContain("приехал на");
    expect(srt.body).not.toMatch(/^Я /m); // hidden word stays out of subtitles
    const vtt = await app.fastify.inject({ method: "GET", url: outs.vtt! });
    expect(vtt.body.startsWith("WEBVTT")).toBe(true);
    expect((rj.result!.validations as Record<string, { ok: boolean }>).captioned!.ok).toBe(true);

    // Same inputs → cached artifacts, no re-encode.
    const again = await api<{ id: string }>(app, "POST", `/api/projects/${v.project.id}/render`, { outputs: ["captioned"] });
    const fin2 = await waitJobs(app, v.project.id);
    const r2 = fin2.jobs.find((j) => j.id === again.json.id)!;
    expect(r2.result).toMatchObject({ encoder: "cached", outputs: { captioned: outs.captioned } });

    const summary = (await api<{ thumbnailUrl: string; lastRenderUrl: string; hasTranscript: boolean }[]>(app, "GET", "/api/projects")).json[0]!;
    expect(summary.thumbnailUrl).toMatch(/thumb\.jpg$/);
    expect(summary.hasTranscript).toBe(true);
    expect(summary.lastRenderUrl).toBeTruthy();
  });

  it("drops a late alignment result when the words changed meanwhile", async () => {
    const { app, dir } = await start({ workerEnv: { FAKE_ALIGN_DELAY_MS: "400" } });
    const clip = makeClip(join(dir, "clip.mp4"), 2);
    const created = await upload(app, readFileSync(clip), "clip.mp4", 1024 * 1024);
    const v = await waitJobs(app, created.project.id);
    const pid = v.project.id;

    // Edit 1: insert "на" → align job A (slow).
    const p1 = toEditedParagraphs(v.transcript!.doc);
    p1[0]!.runs.splice(4, 0, { text: "на ", wordId: null });
    const s1 = (await api<SaveTranscriptRes>(app, "PUT", `/api/projects/${pid}/transcript`, { baseRev: 1, paragraphs: p1 })).json;
    // Wait until A is running, then edit the same word again.
    for (;;) {
      const j = (await api<{ status: string }>(app, "GET", `/api/jobs/${s1.alignJobId}`)).json;
      if (j.status === "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const p2 = toEditedParagraphs(s1.revision.doc);
    const naRun = p2[0]!.runs.find((r) => r.text === "на")!;
    naRun.text = "на-на";
    const s2 = await api<SaveTranscriptRes>(app, "PUT", `/api/projects/${pid}/transcript`, { baseRev: 2, paragraphs: p2 });
    expect(s2.status).toBe(200);
    expect(s2.json.revision.rev).toBe(3);

    const fin = await waitJobs(app, pid);
    const jobA = fin.jobs.find((j) => j.id === s1.alignJobId)!;
    // Job A's window fingerprint no longer matches: nothing applied from it.
    expect(jobA.status).toBe("done");
    expect(jobA.result).toMatchObject({ applied: 0 });
    const jobB = fin.jobs.find((j) => j.id === s2.json.alignJobId)!;
    expect(jobB.result).toMatchObject({ applied: 1, wrote: true });
    const revs = (await api<{ rev: number; actor: string }[]>(app, "GET", `/api/projects/${pid}/transcript/revisions`)).json;
    expect(revs.map((r) => r.actor)).toEqual(["asr", "user", "user", "align"]);
    const word = fin.transcript!.doc.paragraphs[0]!.words.find((w) => w.text === "на-на")!;
    expect(word.timing).toBe("aligned");
  });

  it("never overwrites an existing transcript when seeding ASR finishes late", async () => {
    const { app, dir } = await start({ workerEnv: { FAKE_ASR_DELAY_MS: "800" } });
    const clip = makeClip(join(dir, "clip.mp4"), 2);
    const created = await upload(app, readFileSync(clip), "clip.mp4", 1024 * 1024);
    // User types a transcript before ASR returns.
    for (;;) {
      const v = (await api<ProjectView>(app, "GET", `/api/projects/${created.project.id}`)).json;
      if (v.jobs.some((j) => j.kind === "asr" && j.status === "running")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const s = await api<SaveTranscriptRes>(app, "PUT", `/api/projects/${created.project.id}/transcript`, {
      baseRev: 0,
      paragraphs: [{ id: null, runs: [{ text: "мой текст", wordId: null }] }],
    });
    expect(s.status).toBe(200);
    const fin = await waitJobs(app, created.project.id);
    const asrJob = fin.jobs.find((j) => j.kind === "asr")!;
    expect(asrJob.result).toMatchObject({ seeded: false });
    expect(fin.hypotheses).toHaveLength(1);
    expect(fin.transcript!.doc.paragraphs[0]!.words.map((w) => w.text)).toEqual(["мой", "текст"]);
  });

  it("compare produces loudness-matched clips per preset", async () => {
    const { app, dir } = await start();
    const clip = makeClip(join(dir, "clip.mp4"), 3);
    const created = await upload(app, readFileSync(clip), "clip.mp4", 1024 * 1024);
    await waitJobs(app, created.project.id);
    const j = await api<{ id: string }>(app, "POST", `/api/projects/${created.project.id}/compare`, {});
    const fin = await waitJobs(app, created.project.id);
    const job = fin.jobs.find((x) => x.id === j.json.id)!;
    expect(job.status, job.error ?? "").toBe("done");
    const clips = job.result!.clips as { excerpt: string; variants: Record<string, string> }[];
    expect(clips[0]!.excerpt).toBe("calm");
    expect(Object.keys(clips[0]!.variants).sort()).toEqual(["gentle", "original", "strong", "voice"]);
    const arts = fin.artifacts.filter((a) => a.kind === "compare_clip");
    for (const a of arts) expect(Math.abs((a.meta.inputLufs as number) - -16)).toBeLessThan(40);
  });

  it("lists providers with disabled cloud entries", async () => {
    const { app } = await start({ noScheduler: true });
    const list = (await api<{ id: string; enabled: boolean; reason?: string; local: boolean }[]>(app, "GET", "/api/providers")).json;
    expect(list.find((p) => p.id === "faster-whisper")).toMatchObject({ enabled: true, local: true });
    const el = list.find((p) => p.id === "elevenlabs")!;
    expect(el.enabled).toBe(false);
    expect(el.reason).toMatch(/ELEVENLABS_API_KEY|not implemented/);
  });
});
