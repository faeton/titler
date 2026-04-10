import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { nanoid } from "nanoid";
import { projectDir, WORK_DIR, IN_DIR } from "./paths.js";
import type { Project } from "./types.js";

// Filesystem-backed project store. Each project lives at
// work/<id>/project.json; we scan on demand.

const projectJson = (id: string) => resolve(projectDir(id), "project.json");

export const createProject = (originalFile: string): Project => {
  const id = nanoid(10);
  mkdirSync(projectDir(id), { recursive: true });
  const project: Project = {
    id,
    name: basename(originalFile),
    originalFile,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(projectJson(id), JSON.stringify(project, null, 2));
  return project;
};

export const getProject = (id: string): Project | null => {
  const path = projectJson(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Project;
};

export const updateProject = (
  id: string,
  patch: Partial<Project>,
): Project => {
  const existing = getProject(id);
  if (!existing) throw new Error(`project ${id} not found`);
  const updated = { ...existing, ...patch };
  writeFileSync(projectJson(id), JSON.stringify(updated, null, 2));
  return updated;
};

export const listProjects = (
  opts?: { includeArchived?: boolean },
): Project[] => {
  if (!existsSync(WORK_DIR)) return [];
  const out: Project[] = [];
  for (const entry of readdirSync(WORK_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = getProject(entry.name);
    if (!p) continue;
    if (p.archived && !opts?.includeArchived) continue;
    out.push(p);
  }
  // Sort by video recording date (newest first), fall back to project creation date
  out.sort((a, b) => {
    const dateA = a.source?.original.createdAt ?? a.createdAt;
    const dateB = b.source?.original.createdAt ?? b.createdAt;
    return dateB.localeCompare(dateA);
  });
  return out;
};

// Convenience: return the files present in in/ that aren't yet attached
// to any project. The studio lists these so the user can pick one to
// ingest. Video extensions only.
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]);

export const listInbox = (): string[] => {
  if (!existsSync(IN_DIR)) return [];
  const attached = new Set(listProjects().map((p) => p.originalFile));
  const out: string[] = [];
  for (const entry of readdirSync(IN_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    const dot = lower.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = lower.slice(dot);
    if (!VIDEO_EXTS.has(ext)) continue;
    const full = resolve(IN_DIR, entry.name);
    if (attached.has(full)) continue;
    out.push(full);
  }
  return out.sort();
};
