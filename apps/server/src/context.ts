import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Artifact, ArtifactKind } from "@titler/core";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { Scheduler } from "./jobs.js";
import type { Store } from "./store.js";
import type { WorkerManager } from "./workers.js";

export interface Logger {
  info: (o: unknown, msg?: string) => void;
  warn: (o: unknown, msg?: string) => void;
  error: (o: unknown, msg?: string) => void;
}

export interface Ctx {
  cfg: Config;
  store: Store;
  sched: Scheduler;
  workers: WorkerManager;
  log: Logger;
  auth: Auth;
}

// ---- content-addressed artifacts -------------------------------------------------

/** JSON with sorted object keys, so equal params always hash equally. */
export const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
};

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** key = sha256(stage, parent keys, canonical params, producer version). */
export const artifactKey = (stage: string, parents: string[], params: unknown, version: string): string =>
  sha256(canonical({ stage, parents, params, version }));

export const abs = (cfg: Config, rel: string): string => resolve(cfg.dataDir, rel);

export const artifactUrl = (a: Pick<Artifact, "key" | "path">, file?: string): string =>
  `/api/artifacts/${a.key}/${encodeURIComponent(file ?? basename(a.path))}`;

/** Existing artifact whose main file is still on disk. */
export const findArtifact = (ctx: Ctx, key: string): Artifact | null => {
  const a = ctx.store.getArtifact(key);
  return a && existsSync(abs(ctx.cfg, a.path)) ? a : null;
};

export interface Produced {
  /** Main file name inside the artifact dir. */
  file: string;
  meta?: Record<string, unknown>;
}

/**
 * Return the artifact for `key`, producing it if missing. `produce` writes into
 * a private temp dir that is renamed into place only on success, so a crash or
 * cancellation never leaves a half-written artifact under its final key.
 */
const inflight = new Map<string, Promise<Artifact>>();

export const ensureArtifact = (
  ctx: Ctx,
  spec: { key: string; projectId: string; kind: ArtifactKind },
  produce: (dir: string) => Promise<Produced>,
): Promise<Artifact> => {
  // Single-flight per key: concurrent jobs needing the same artifact share one producer.
  const running = inflight.get(spec.key);
  if (running) return running;
  const p = produceArtifact(ctx, spec, produce).finally(() => inflight.delete(spec.key));
  inflight.set(spec.key, p);
  return p;
};

const produceArtifact = async (
  ctx: Ctx,
  spec: { key: string; projectId: string; kind: ArtifactKind },
  produce: (dir: string) => Promise<Produced>,
): Promise<Artifact> => {
  const existing = findArtifact(ctx, spec.key);
  if (existing) return existing;
  const relDir = join("artifacts", spec.key);
  const finalDir = abs(ctx.cfg, relDir);
  const tmp = `${finalDir}.tmp-${randomBytes(4).toString("hex")}`;
  await mkdir(tmp, { recursive: true });
  try {
    const out = await produce(tmp);
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmp, finalDir);
    return ctx.store.putArtifact({ key: spec.key, projectId: spec.projectId, kind: spec.kind, path: join(relDir, out.file), meta: out.meta ?? {} });
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
};

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
