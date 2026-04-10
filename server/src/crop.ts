import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { projectDir, SCRIPTS_DIR, VENV_PYTHON } from "./paths.js";
import { getProject, updateProject } from "./projects.js";
import type { FaceTrackResult } from "./types.js";

export type FaceTrackProgress =
  | { phase: "scanning"; percent: number }
  | { phase: "done"; result: FaceTrackResult }
  | { phase: "error"; message: string };

export const runFaceTrack = async (
  projectId: string,
  onProgress: (p: FaceTrackProgress) => void,
): Promise<FaceTrackResult> => {
  const project = getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  if (!project.source) throw new Error(`project ${projectId} not ingested`);

  const dir = projectDir(projectId);
  const outputPath = resolve(dir, "face_track.json");
  const script = resolve(SCRIPTS_DIR, "face_track.py");

  // Run against the original file (higher resolution = better detection)
  const videoPath = project.originalFile;

  return new Promise((res, rej) => {
    const proc = spawn(VENV_PYTHON, [script, videoPath, outputPath]);
    let stderr = "";

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Parse progress from stderr lines like "  scanning 45% (12 faces)"
      const match = text.match(/(\d+)%/);
      if (match) {
        onProgress({ phase: "scanning", percent: Number(match[1]) });
      }
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text === "DONE") {
        // Read result
        import("node:fs").then(({ readFileSync }) => {
          try {
            const result = JSON.parse(
              readFileSync(outputPath, "utf-8"),
            ) as FaceTrackResult;
            // Save to project
            updateProject(projectId, { faceTrack: result });
            onProgress({ phase: "done", result });
            res(result);
          } catch (e) {
            rej(new Error(`failed to parse face track output: ${e}`));
          }
        });
      }
    });

    proc.on("error", rej);
    proc.on("close", (code) => {
      if (code !== 0) {
        rej(new Error(`face_track.py exited ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
};
