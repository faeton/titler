/**
 * Inbox watcher. Watches the in/ directory for new video files.
 * When a stable new file appears (size unchanged for 2s — handles
 * AirDrop/Finder partial copies), auto-creates a project and queues
 * ingest + transcribe via the job system.
 */

import * as chokidar from "chokidar";
import { statSync } from "node:fs";
import { resolve, extname } from "node:path";
import { IN_DIR } from "./paths.js";
import { listProjects, createProject } from "./projects.js";
import { submitJob } from "./jobs.js";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]);

// Track files being stabilized (waiting for copy to finish)
const pending = new Map<string, { size: number; timer: ReturnType<typeof setTimeout> }>();

// Listeners for real-time notifications to connected browsers
type InboxListener = (event: { type: string; file?: string; projectId?: string }) => void;
const listeners = new Set<InboxListener>();

export const onInboxEvent = (fn: InboxListener) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const notify = (event: { type: string; file?: string; projectId?: string }) => {
  for (const fn of listeners) {
    try { fn(event); } catch { /* ignore */ }
  }
};

const isVideoFile = (path: string): boolean => {
  const ext = extname(path).toLowerCase();
  return VIDEO_EXTS.has(ext);
};

const isAlreadyImported = (filePath: string): boolean => {
  const projects = listProjects({ includeArchived: true });
  return projects.some((p) => p.originalFile === filePath);
};

const handleStableFile = (filePath: string) => {
  if (!isVideoFile(filePath)) return;
  if (isAlreadyImported(filePath)) return;

  const name = filePath.split("/").pop() ?? filePath;
  console.log(`[inbox] new file detected: ${name}`);
  notify({ type: "new_file", file: filePath });

  try {
    const project = createProject(filePath);
    console.log(`[inbox] created project ${project.id} for ${name}`);
    submitJob(project.id, ["ingest", "transcribe"]);
    console.log(`[inbox] queued ingest+transcribe for ${project.id}`);
    notify({ type: "project_created", file: filePath, projectId: project.id });
  } catch (e) {
    console.error(`[inbox] error processing ${name}:`, e);
  }
};

// Debounce by file size: wait until size is stable for 2s
const checkStability = (filePath: string) => {
  try {
    const { size } = statSync(filePath);
    const existing = pending.get(filePath);

    if (existing) {
      clearTimeout(existing.timer);
      if (existing.size === size) {
        // Size unchanged — file is stable
        pending.delete(filePath);
        handleStableFile(filePath);
        return;
      }
    }

    // Size changed or first check — wait and recheck
    const timer = setTimeout(() => checkStability(filePath), 2000);
    pending.set(filePath, { size, timer });
  } catch {
    // File might have been removed
    pending.delete(filePath);
  }
};

let watcher: ReturnType<typeof chokidar.watch> | null = null;

export const startInboxWatcher = () => {
  if (watcher) return;

  console.log(`[inbox] watching ${IN_DIR}`);

  watcher = chokidar.watch(IN_DIR, {
    ignoreInitial: true, // don't process existing files on startup
    depth: 0, // only top-level files
    awaitWriteFinish: false, // we handle stability ourselves
  });

  watcher.on("add", (filePath: string) => {
    if (!isVideoFile(filePath)) return;
    if (isAlreadyImported(filePath)) return;
    console.log(`[inbox] file appeared: ${filePath}`);
    setTimeout(() => checkStability(filePath), 1000);
  });

  watcher.on("error", (err: unknown) => {
    console.error("[inbox] watcher error:", err);
  });
};

export const stopInboxWatcher = () => {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
};
