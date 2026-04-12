/**
 * Presets — saved style configurations. Stored as JSON files in presets/.
 * A preset captures: style, watermark flag, crop mode.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PRESETS_DIR } from "./paths.js";

export type Preset = {
  id: string;
  name: string;
  style: string;
  watermark: boolean;
  cropMode: string;
  createdAt: string;
};

const presetPath = (id: string) => resolve(PRESETS_DIR, `${id}.json`);

export const listPresets = (): Preset[] => {
  if (!existsSync(PRESETS_DIR)) return [];
  const out: Preset[] = [];
  for (const entry of readdirSync(PRESETS_DIR)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(resolve(PRESETS_DIR, entry), "utf-8"));
      out.push(data as Preset);
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

export const getPreset = (id: string): Preset | null => {
  const p = presetPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Preset;
};

export const savePreset = (preset: Preset): void => {
  writeFileSync(presetPath(preset.id), JSON.stringify(preset, null, 2));
};

export const deletePreset = (id: string): boolean => {
  const p = presetPath(id);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
};
