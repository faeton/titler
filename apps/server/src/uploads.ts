import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, truncate } from "node:fs/promises";
import { extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UploadState } from "@titler/core";
import { abs, type Ctx } from "./context.js";
import { HttpError } from "./pipeline/transcript.js";
import type { ProjectRow, UploadRow } from "./store.js";

export const uploadState = (u: UploadRow): UploadState => ({ id: u.id, name: u.name, size: u.size, received: u.received });

const MAX_SIZE = 64 * 1024 ** 3;

export const createUpload = async (ctx: Ctx, body: { name?: unknown; size?: unknown; lastModified?: unknown }): Promise<UploadRow> => {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 300) : "";
  const size = Number(body.size);
  if (!name) throw new HttpError(400, "name required");
  if (!Number.isInteger(size) || size <= 0 || size > MAX_SIZE) throw new HttpError(400, "size must be a positive integer");
  const u = ctx.store.createUpload({
    name,
    size,
    lastModified: typeof body.lastModified === "string" ? body.lastModified : null,
    path: "", // set below
  });
  const rel = join("uploads", `${u.id}.part`);
  ctx.store.db.prepare("UPDATE uploads SET path = ? WHERE id = ?").run(rel, u.id);
  await mkdir(abs(ctx.cfg, "uploads"), { recursive: true });
  await (await open(abs(ctx.cfg, rel), "w")).close();
  return ctx.store.getUpload(u.id)!;
};

const writing = new Set<string>();

/**
 * Append a chunk at `offset` (must equal `received`). Bytes that reach the
 * disk count even if the client disconnects mid-chunk, so resume continues
 * from whatever actually landed.
 */
export const writeChunk = async (ctx: Ctx, id: string, offset: number, body: Readable, contentLength?: number): Promise<UploadRow> => {
  const u = ctx.store.getUpload(id);
  if (!u) throw new HttpError(404, "upload not found");
  if (writing.has(id)) throw new HttpError(409, "another chunk is being written", { received: u.received });
  if (!Number.isInteger(offset) || offset !== u.received) throw new HttpError(409, "offset mismatch", { received: u.received });
  if (contentLength !== undefined && offset + contentLength > u.size) {
    throw new HttpError(400, "chunk exceeds declared size", { received: u.received });
  }
  writing.add(id);
  const path = abs(ctx.cfg, u.path);
  let written = 0;
  try {
    const fh = await open(path, "r+");
    await fh.truncate(u.received); // drop any partial tail from an earlier crash
    const ws = fh.createWriteStream({ start: offset, autoClose: true });
    let overflow = false;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (offset + written > u.size) {
          overflow = true;
          return cb(new HttpError(400, "chunk exceeds declared size"));
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, limit, ws);
    } catch (e) {
      if (overflow) {
        await truncate(path, u.received).catch(() => {});
        throw new HttpError(400, "chunk exceeds declared size", { received: u.received });
      }
      // Client aborted: keep what reached the disk.
      const onDisk = (await stat(path)).size;
      ctx.store.setUploadReceived(id, Math.min(u.size, onDisk));
      throw e;
    }
    const onDisk = (await stat(path)).size;
    ctx.store.setUploadReceived(id, Math.min(u.size, onDisk));
    return ctx.store.getUpload(id)!;
  } finally {
    writing.delete(id);
  }
};

const hashFile = async (path: string): Promise<string> => {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
};

/** Finish: hash, dedupe by sha256, move into sources/, create project, enqueue ingest. */
export const completeUpload = async (ctx: Ctx, id: string): Promise<ProjectRow> => {
  const u = ctx.store.getUpload(id);
  if (!u) throw new HttpError(404, "upload not found");
  if (writing.has(id)) throw new HttpError(409, "upload still writing", { received: u.received });
  if (u.received !== u.size) throw new HttpError(409, "upload incomplete", { received: u.received });
  const part = abs(ctx.cfg, u.path);
  const sha = await hashFile(part);

  const existing = ctx.store.projectBySha(sha);
  if (existing) {
    await rm(part, { force: true });
    ctx.store.deleteUpload(id);
    if (existing.archived) ctx.store.updateProject(existing.id, { archived: false });
    return ctx.store.getProject(existing.id)!;
  }

  const ext = (extname(u.name).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin").slice(0, 10);
  const rel = join("sources", `${sha}${ext}`);
  await mkdir(abs(ctx.cfg, "sources"), { recursive: true });
  await rename(part, abs(ctx.cfg, rel));
  const name = u.name.replace(/\.[^.]+$/, "") || u.name;
  const p = ctx.store.tx(() => {
    const again = ctx.store.projectBySha(sha); // concurrent complete of the same bytes
    if (again) return again;
    const created = ctx.store.createProject({ name, sourceSha256: sha, sourceName: u.name, sourcePath: rel });
    ctx.store.deleteUpload(id);
    return created;
  });
  if (p.sourcePath === rel && !ctx.store.listJobs({ projectId: p.id }).length) ctx.sched.enqueue(p.id, "ingest", {});
  return p;
};
