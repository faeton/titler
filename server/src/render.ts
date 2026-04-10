import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { projectDir, OUT_DIR, REPO_ROOT } from "./paths.js";
import { getProject } from "./projects.js";

export type RenderProgress =
  | { phase: "start" }
  | { phase: "bundling"; percent: number }
  | { phase: "rendering"; percent: number }
  | { phase: "done"; outputPath: string }
  | { phase: "error"; message: string };

export const renderProject = async (
  projectId: string,
  style: string,
  onProgress: (p: RenderProgress) => void,
): Promise<string> => {
  const project = getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  if (!project.source) throw new Error(`project ${projectId} not ingested`);
  if (!project.transcript)
    throw new Error(`project ${projectId} not transcribed`);

  onProgress({ phase: "start" });

  // Dynamic imports to keep server startup fast
  const { bundle } = await import("@remotion/bundler");
  const { renderMedia, selectComposition } = await import(
    "@remotion/renderer"
  );

  // Bundle the Remotion entry point
  const entryPoint = resolve(REPO_ROOT, "remotion", "src", "index.ts");
  onProgress({ phase: "bundling", percent: 0 });

  const bundled = await bundle({
    entryPoint,
    onProgress: (p: number) => {
      onProgress({ phase: "bundling", percent: Math.round(p) });
    },
  });

  // Serve the source video over HTTP — Chrome Headless blocks file:// URLs.
  // Our Fastify server on :7777 already has GET /projects/:id/source.mp4.
  const port = process.env.TITLER_STUDIO_PORT ?? "7777";
  const sourceUrl = `http://127.0.0.1:${port}/projects/${projectId}/source.mp4`;

  const inputProps = {
    sourceUrl,
    transcript: project.transcript,
    durationInSeconds: project.source.original.duration,
    circle: project.source.circle ?? null,
    style,
  };

  const composition = await selectComposition({
    serveUrl: bundled,
    id: "TitlerVideo",
    inputProps,
  });

  // Output path
  mkdirSync(OUT_DIR, { recursive: true });
  const safeName = project.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const outputPath = resolve(OUT_DIR, `${safeName}_${style}.mp4`);

  onProgress({ phase: "rendering", percent: 0 });

  // Use all available CPU cores for parallel frame rendering.
  // On M3 Max this gives ~4-6x speedup over concurrency=1.
  const { cpus } = await import("node:os");
  const cores = Math.max(1, Math.min(cpus().length, 16));

  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    concurrency: cores,
    onProgress: ({ progress }) => {
      onProgress({
        phase: "rendering",
        percent: Math.round(progress * 100),
      });
    },
  });

  onProgress({ phase: "done", outputPath });
  return outputPath;
};
