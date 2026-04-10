import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { projectDir, SCRIPTS_DIR, VENV_PYTHON } from "./paths.js";
import { getProject, updateProject } from "./projects.js";
import type { Transcript } from "./types.js";

// Run scripts/transcribe_mlx.py as a subprocess, using the project's
// normalized audio (work/<id>/audio.wav). Streams stderr lines as
// progress; reads the final JSON file once the process exits OK.

export type TranscribeProgress =
  | { phase: "start" }
  | { phase: "log"; line: string }
  | { phase: "done"; transcript: Transcript };

export const transcribeProject = async (
  projectId: string,
  onProgress: (p: TranscribeProgress) => void,
): Promise<Transcript> => {
  const project = getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  if (!project.source)
    throw new Error(`project ${projectId} not ingested yet`);

  const dir = projectDir(projectId);
  const outJson = resolve(dir, "transcript.json");
  const script = resolve(SCRIPTS_DIR, "transcribe.py");
  const python = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";

  onProgress({ phase: "start" });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn(python, [script, project.source!.audioPath, outJson], {
      env: process.env,
    });

    let stderrBuf = "";
    let stdoutBuf = "";

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      let idx: number;
      while ((idx = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, idx).trim();
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line) onProgress({ phase: "log", line });
      }
    });
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });
    proc.on("error", rejectPromise);
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(`transcribe_mlx exited ${code}: ${stderrBuf.slice(-800)}`),
        );
        return;
      }
      if (!stdoutBuf.includes("DONE")) {
        rejectPromise(new Error("transcribe_mlx: missing DONE marker"));
        return;
      }
      resolvePromise();
    });
  });

  const transcript = JSON.parse(readFileSync(outJson, "utf-8")) as Transcript;
  updateProject(projectId, { transcript });
  onProgress({ phase: "done", transcript });
  return transcript;
};
