// End-to-end smoke against a running server:
//   pnpm --filter @titler/server start   (or dev), then
//   pnpm --filter @titler/server e2e [file] [--base http://127.0.0.1:8772] [--compare]
// Uploads in chunks (with a simulated resume), waits for ingest + ASR, edits one
// word, waits for local alignment, renders captioned + clean + SRT/VTT.
import { open, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { toEditedParagraphs, type Job, type ProjectView, type SaveTranscriptRes, type UploadState } from "@titler/core";
import { REPO_ROOT } from "../src/config.js";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const BASE = opt("--base") ?? process.env.TITLER_BASE ?? "http://127.0.0.1:8772";
const FILE = resolve(argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--")) ?? resolve(REPO_ROOT, "bench/samples/video-34442_singular_display.mov"));
const CHUNK = 4 * 1024 * 1024;
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a: unknown[]) => console.log(`[${since()}]`, ...a);

const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(BASE + path, {
    method,
    headers: body instanceof Uint8Array ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {},
    body: body instanceof Uint8Array ? (body as unknown as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : null) as T;
};

const waitJob = async (id: string, label: string, timeoutMs = 30 * 60_000): Promise<Job> => {
  let last = "";
  const start = Date.now();
  for (;;) {
    const j = await call<Job>("GET", `/api/jobs/${id}`);
    const line = `${label}: ${j.status} ${j.progress !== null ? Math.round(j.progress * 100) + "%" : ""} ${j.message ?? ""}`.trim();
    if (line !== last) log(line);
    last = line;
    if (!["queued", "running"].includes(j.status)) return j;
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

const view = (id: string) => call<ProjectView>("GET", `/api/projects/${id}`);

const main = async () => {
  const size = (await stat(FILE)).size;
  log(`server ${BASE}, file ${basename(FILE)} (${(size / 1e6).toFixed(1)} MB)`);
  const health = await call<{ vaapi: boolean }>("GET", "/api/health");

  // ---- upload, interrupted after the first chunk and resumed ----
  const fh = await open(FILE, "r");
  let up = await call<UploadState>("POST", "/api/uploads", { name: basename(FILE), size });
  const tUp = Date.now();
  let first = true;
  while (up.received < size) {
    const n = Math.min(CHUNK, size - up.received);
    const buf = new Uint8Array(n);
    await fh.read(buf, 0, n, up.received);
    up = await call<UploadState>("PUT", `/api/uploads/${up.id}?offset=${up.received}`, buf);
    if (first) {
      first = false;
      up = await call<UploadState>("GET", `/api/uploads/${up.id}`); // "reconnect": ask where to resume
      log(`resume check: server has ${up.received} bytes`);
    }
  }
  await fh.close();
  let v = await call<ProjectView>("POST", `/api/uploads/${up.id}/complete`);
  const uploadS = (Date.now() - tUp) / 1000;
  const pid = v.project.id;
  log(`uploaded in ${uploadS.toFixed(1)}s → project ${pid} (${v.jobs.length} jobs; existing project if deduped)`);

  // ---- ingest + analyze + ASR ----
  for (const kind of ["ingest", "analyze", "asr"] as const) {
    v = await view(pid);
    const j = v.jobs.find((x) => x.kind === kind);
    if (!j) {
      log(`${kind}: no job`);
      continue;
    }
    const done = await waitJob(j.id, kind);
    if (done.status !== "done") log(`${kind} ${done.status}: ${done.error}`);
  }
  v = await view(pid);
  const ingestJob = v.jobs.find((x) => x.kind === "ingest");
  log("probe", JSON.stringify(v.project.probe));
  log("proxy", v.urls.proxy, "encoder", ingestJob?.result?.encoder);

  // ---- edit one word ----
  let editInfo = "skipped (no transcript)";
  let alignInfo = "";
  if (v.transcript) {
    const t = v.transcript;
    const paras = toEditedParagraphs(t.doc);
    const runs = paras[0]!.runs;
    const target = runs.find((r) => r.wordId && r.text.replace(/[^\p{L}]/gu, "").length >= 4) ?? runs[0]!;
    const before = target.text;
    target.text = before.endsWith("!") ? before.slice(0, -1) : before.replace(/[.,!?…]*$/, "!");
    const saved = await call<SaveTranscriptRes>("PUT", `/api/projects/${pid}/transcript`, { baseRev: t.rev, paragraphs: paras });
    editInfo = `"${before}" → "${target.text}" rev ${t.rev}→${saved.revision.rev}, changed=${saved.changed.length}`;
    log("edit", editInfo);
    if (saved.alignJobId) {
      const aj = await waitJob(saved.alignJobId, "align", 10 * 60_000);
      alignInfo = `${aj.status} ${JSON.stringify(aj.result ?? aj.error)}`;
      const after = await view(pid);
      const w = after.transcript?.doc.paragraphs.flatMap((p) => p.words).find((x) => x.text === target.text);
      alignInfo += ` → word timing=${w?.timing} ${w?.start}-${w?.end} (latest rev ${after.transcript?.rev} by ${after.transcript?.actor})`;
    }
  }

  // ---- optional audio comparison ----
  let compareInfo = "";
  if (flag("--compare")) {
    const cj = await call<Job>("POST", `/api/projects/${pid}/compare`, {});
    const done = await waitJob(cj.id, "compare");
    compareInfo = `${done.status} ${JSON.stringify(done.result ?? done.error)}`;
  }

  // ---- render ----
  const outputs = v.transcript ? ["captioned", "clean", "srt", "vtt"] : ["clean"];
  const rj = await call<Job>("POST", `/api/projects/${pid}/render`, { outputs });
  const tR = Date.now();
  const r = await waitJob(rj.id, "render");
  const renderS = (Date.now() - tR) / 1000;

  console.log("\n==== e2e summary ====");
  console.log(`server         ${BASE} (vaapi available: ${health.vaapi})`);
  console.log(`project        ${pid} "${v.project.name}"`);
  console.log(`upload         ${(size / 1e6).toFixed(1)} MB in ${uploadS.toFixed(1)}s, chunks of ${CHUNK / 1e6} MB, resumed once`);
  console.log(`ingest         ${ingestJob?.status} encoder=${ingestJob?.result?.encoder ?? "-"}`);
  const asrJob = v.jobs.find((x) => x.kind === "asr");
  console.log(`asr            ${asrJob?.status} ${JSON.stringify(asrJob?.result ?? asrJob?.error ?? null)}`);
  console.log(`transcript     ${v.transcript ? `${v.transcript.doc.paragraphs.flatMap((p) => p.words).length} words` : "none"}`);
  console.log(`edit           ${editInfo}`);
  if (alignInfo) console.log(`align          ${alignInfo}`);
  if (compareInfo) console.log(`compare        ${compareInfo}`);
  console.log(`render         ${r.status} in ${renderS.toFixed(1)}s encoder=${r.result?.encoder ?? "-"} ${r.error ?? ""}`);
  for (const [k, u] of Object.entries((r.result?.outputs ?? {}) as Record<string, string>)) console.log(`  ${k.padEnd(10)} ${BASE}${u}`);
  const val = (r.result?.validations ?? {}) as Record<string, { ok: boolean; durationMs: number; problems: string[] }>;
  for (const [k, x] of Object.entries(val)) console.log(`  validate ${k}: ok=${x.ok} duration=${x.durationMs}ms ${x.problems.join("; ")}`);
  console.log(`total          ${since()}`);
  if (r.status !== "done") process.exit(1);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
