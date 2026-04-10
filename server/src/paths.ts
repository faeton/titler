import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

// Resolve filesystem locations relative to the repo root (titler/),
// regardless of the cwd the server was launched from.

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", ".."); // server/src/ → repo

export const IN_DIR = resolve(REPO_ROOT, "in");
export const OUT_DIR = resolve(REPO_ROOT, "out");
export const WORK_DIR = resolve(REPO_ROOT, "work");
export const PRESETS_DIR = resolve(REPO_ROOT, "presets");
export const SCRIPTS_DIR = resolve(REPO_ROOT, "scripts");
export const VENV_PYTHON = resolve(REPO_ROOT, ".venv", "bin", "python");

export const projectDir = (projectId: string) =>
  resolve(WORK_DIR, projectId);

export const ensureDirs = () => {
  for (const d of [IN_DIR, OUT_DIR, WORK_DIR, PRESETS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
};
