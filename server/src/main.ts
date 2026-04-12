import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { IN_DIR, OUT_DIR, WORK_DIR, ensureDirs, REPO_ROOT, projectDir } from "./paths.js";
import {
  createProject,
  getProject,
  updateProject,
  listInbox,
  listProjects,
} from "./projects.js";
import { ingestProject, type IngestProgress } from "./ingest.js";
import { transcribeProject, type TranscribeProgress } from "./transcribe.js";
import { runFaceTrack, type FaceTrackProgress } from "./crop.js";
import {
  submitJob,
  submitBatch,
  getJob,
  listJobs,
  clearFinishedJobs,
  queueSize,
  queuePending,
  type JobStep,
} from "./jobs.js";
import { rmSync } from "node:fs";
import type { CropMode } from "./types.js";
import { startInboxWatcher, onInboxEvent } from "./inbox.js";
import { listPresets, getPreset, savePreset, deletePreset, type Preset } from "./presets.js";
import { nanoid } from "nanoid";

ensureDirs();

const app = Fastify({
  logger: { level: "info" },
  bodyLimit: 100 * 1024 * 1024,
});

await app.register(cors, { origin: true });

// Serve the normalized source MP4 for a project. The Remotion Player
// in the studio fetches this directly.
app.get<{ Params: { id: string } }>(
  "/projects/:id/source.mp4",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project?.source) return reply.code(404).send({ error: "not_ingested" });
    return reply.sendFile("source.mp4", projectDir(project.id));
  },
);

// Static plugin is also used to serve a project's work directory. We
// register one instance per project on demand via sendFile above.
await app.register(fastifyStatic, {
  root: WORK_DIR,
  serve: false, // we send explicit files via reply.sendFile
  decorateReply: true,
});

// Serve rendered outputs from out/
await app.register(fastifyStatic, {
  root: OUT_DIR,
  prefix: "/out/",
  decorateReply: false,
});

// List rendered files
app.get("/outputs", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  if (!existsSync(OUT_DIR)) return { files: [] };
  const files = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => {
      const st = statSync(resolve(OUT_DIR, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { files };
});

// ----- read routes -----

app.get("/health", async () => ({ ok: true }));

app.get("/inbox", async () => ({ files: listInbox() }));

app.get<{ Querystring: { archived?: string } }>(
  "/projects",
  async (req) => ({
    projects: listProjects({
      includeArchived: req.query.archived === "true",
    }),
  }),
);

app.get<{ Params: { id: string } }>(
  "/projects/:id",
  async (req, reply) => {
    const p = getProject(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    return p;
  },
);

app.get<{ Params: { id: string } }>(
  "/projects/:id/transcript",
  async (req, reply) => {
    const p = getProject(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    if (!p.transcript)
      return reply.code(404).send({ error: "not_transcribed" });
    return p.transcript;
  },
);

// ----- screenshot -----

app.get<{ Params: { id: string }; Querystring: { time?: string } }>(
  "/projects/:id/screenshot",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project?.source)
      return reply.code(404).send({ error: "not_ingested" });

    const time = Number(req.query.time ?? 0);
    const sourcePath = resolve(projectDir(project.id), "source.mp4");
    const outPath = resolve(projectDir(project.id), `frame_${Math.round(time * 100)}.jpg`);

    const { execSync } = await import("node:child_process");
    try {
      execSync(
        `ffmpeg -y -ss ${time.toFixed(3)} -i "${sourcePath}" -frames:v 1 -q:v 2 "${outPath}"`,
        { stdio: "pipe" },
      );
      return reply.sendFile(`frame_${Math.round(time * 100)}.jpg`, projectDir(project.id));
    } catch (e) {
      return reply.code(500).send({ error: "screenshot_failed" });
    }
  },
);

// ----- overlays -----

app.get<{ Params: { id: string } }>(
  "/projects/:id/overlays",
  async (req, reply) => {
    const p = getProject(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    return { overlays: p.overlays ?? [] };
  },
);

app.put<{ Params: { id: string }; Body: { overlays: unknown } }>(
  "/projects/:id/overlays",
  async (req, reply) => {
    const p = getProject(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    const { overlays } = req.body ?? {};
    if (!Array.isArray(overlays))
      return reply.code(400).send({ error: "overlays_array_required" });
    updateProject(p.id, { overlays });
    return { ok: true, count: overlays.length };
  },
);

// ----- PATCH transcript (edit words) -----

app.patch<{ Params: { id: string }; Body: { words: unknown } }>(
  "/projects/:id/transcript",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "not_found" });
    if (!project.transcript)
      return reply.code(409).send({ error: "not_transcribed" });

    const { words } = req.body ?? {};
    if (!Array.isArray(words))
      return reply.code(400).send({ error: "words_array_required" });

    // Merge: keep original timings, update text
    const updated = project.transcript.words.map((orig, i) => {
      const patch = words[i];
      if (patch && typeof patch === "object" && "text" in patch) {
        return { ...orig, text: String((patch as { text: string }).text) };
      }
      return orig;
    });

    const newTranscript = { ...project.transcript, words: updated };
    updateProject(project.id, { transcript: newTranscript });

    // Also write the standalone transcript.json for render
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      resolve(projectDir(project.id), "transcript.json"),
      JSON.stringify(newTranscript, null, 2),
    );

    // Mark project as edited
    updateProject(project.id, { transcript: newTranscript, edited: true });

    return { ok: true, words: updated.length };
  },
);

// ----- mutation / job routes -----

app.post<{ Body: { file: string } }>(
  "/projects",
  async (req, reply) => {
    const { file } = req.body ?? {};
    if (!file || typeof file !== "string")
      return reply.code(400).send({ error: "file_required" });
    // Security: only accept paths under in/
    const absolute = resolve(file);
    if (!absolute.startsWith(IN_DIR + "/"))
      return reply
        .code(400)
        .send({ error: "must_be_in_inbox", inbox: IN_DIR });
    if (!existsSync(absolute))
      return reply.code(404).send({ error: "file_missing" });

    const project = createProject(absolute);
    return project;
  },
);

// SSE helper: each event is one JSON line. The client uses EventSource.
const sse = (reply: import("fastify").FastifyReply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  const send = (obj: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const end = () => {
    reply.raw.end();
  };
  return { send, end };
};

app.post<{ Params: { id: string } }>(
  "/projects/:id/ingest",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "not_found" });

    const { send, end } = sse(reply);
    try {
      await ingestProject(project.id, (p: IngestProgress) => send(p));
    } catch (e) {
      send({ phase: "error", message: (e as Error).message });
    } finally {
      end();
    }
  },
);

app.post<{ Params: { id: string } }>(
  "/projects/:id/transcribe",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "not_found" });
    if (!project.source)
      return reply.code(409).send({ error: "not_ingested" });

    const { send, end } = sse(reply);
    try {
      await transcribeProject(project.id, (p: TranscribeProgress) => send(p));
    } catch (e) {
      send({ phase: "error", message: (e as Error).message });
    } finally {
      end();
    }
  },
);

// ----- face track -----

app.post<{ Params: { id: string } }>(
  "/projects/:id/face-track",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "not_found" });
    if (!project.source)
      return reply.code(409).send({ error: "not_ingested" });

    const { send, end } = sse(reply);
    try {
      await runFaceTrack(project.id, (p: FaceTrackProgress) => send(p));
    } catch (e) {
      send({ phase: "error", message: (e as Error).message });
    } finally {
      end();
    }
  },
);

// ----- re-ingest (change crop mode) -----

app.post<{ Params: { id: string }; Body: { cropMode?: string } }>(
  "/projects/:id/reingest",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "not_found" });

    const cropMode = (req.body?.cropMode ?? "center") as CropMode;
    const faceTrack =
      cropMode === "face_track" ? project.faceTrack : undefined;

    const { send, end } = sse(reply);
    try {
      await ingestProject(project.id, (p: IngestProgress) => send(p), {
        cropMode,
        faceTrack,
      });
    } catch (e) {
      send({ phase: "error", message: (e as Error).message });
    } finally {
      end();
    }
  },
);

// ----- jobs (server-side queue) -----

app.get("/jobs", async () => ({
  jobs: listJobs(),
  queueSize: queueSize(),
  pending: queuePending(),
}));

app.get<{ Params: { id: string } }>(
  "/jobs/:id",
  async (req, reply) => {
    const job = getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "not_found" });
    return job;
  },
);

app.post("/jobs/clear", async () => {
  clearFinishedJobs();
  return { ok: true };
});

// Submit a single project job
app.post<{
  Body: { projectId: string; steps: string[]; style?: string };
}>("/jobs", async (req, reply) => {
  const { projectId, steps, style } = req.body ?? {};
  if (!projectId || !Array.isArray(steps) || steps.length === 0)
    return reply.code(400).send({ error: "projectId_and_steps_required" });
  const project = getProject(projectId);
  if (!project) return reply.code(404).send({ error: "project_not_found" });
  const job = submitJob(projectId, steps as JobStep[], style);
  return job;
});

// Submit a batch of jobs
app.post<{
  Body: { projectIds: string[]; steps: string[]; style?: string };
}>("/jobs/batch", async (req, reply) => {
  const { projectIds, steps, style } = req.body ?? {};
  if (!Array.isArray(projectIds) || !Array.isArray(steps) || steps.length === 0)
    return reply.code(400).send({ error: "projectIds_and_steps_required" });
  const jobs = submitBatch(projectIds, steps as JobStep[], style);
  return { jobs };
});

// Batch import from inbox: create projects + queue ingest+transcribe
app.post<{
  Body: { files: string[] };
}>("/jobs/import", async (req, reply) => {
  const { files } = req.body ?? {};
  if (!Array.isArray(files) || files.length === 0)
    return reply.code(400).send({ error: "files_required" });

  const results: { file: string; projectId?: string; error?: string }[] = [];
  for (const file of files) {
    try {
      const absolute = resolve(file);
      if (!absolute.startsWith(IN_DIR + "/")) {
        results.push({ file, error: "not_in_inbox" });
        continue;
      }
      if (!existsSync(absolute)) {
        results.push({ file, error: "file_missing" });
        continue;
      }
      const project = createProject(absolute);
      submitJob(project.id, ["ingest", "transcribe"]);
      results.push({ file, projectId: project.id });
    } catch (e) {
      results.push({ file, error: (e as Error).message });
    }
  }
  return { results };
});

// ----- rename project -----

app.patch<{ Params: { id: string }; Body: { name: string } }>(
  "/projects/:id/name",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "not_found" });
    const { name } = req.body ?? {};
    if (!name || typeof name !== "string")
      return reply.code(400).send({ error: "name_required" });
    updateProject(project.id, { name: name.trim() });
    return { ok: true, name: name.trim() };
  },
);

// ----- delete project -----

app.delete<{ Params: { id: string } }>(
  "/projects/:id",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "not_found" });
    // Remove work directory
    const dir = projectDir(project.id);
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  },
);

// ----- archive/unarchive -----

app.post<{ Params: { id: string } }>(
  "/projects/:id/archive",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "not_found" });
    updateProject(project.id, { archived: !project.archived });
    return { ok: true, archived: !project.archived };
  },
);

// ----- render -----

app.post<{ Params: { id: string }; Querystring: { style?: string; watermark?: string } }>(
  "/projects/:id/render",
  async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "not_found" });
    if (!project.source)
      return reply.code(409).send({ error: "not_ingested" });
    if (!project.transcript)
      return reply.code(409).send({ error: "not_transcribed" });

    const style = req.query.style ?? "bold";
    const watermark = req.query.watermark !== "false"; // on by default
    const { renderProjectFfmpeg } = await import("./renderFfmpeg.js");

    const { send, end } = sse(reply);
    try {
      await renderProjectFfmpeg(project.id, style, (p) => send(p), { watermark });
      // Track rendered styles
      const rendered = new Set(project.rendered ?? []);
      rendered.add(style);
      updateProject(project.id, { rendered: [...rendered] });
    } catch (e) {
      send({ phase: "error", message: (e as Error).message });
    } finally {
      end();
    }
  },
);

// ----- presets -----

app.get("/presets", async () => ({ presets: listPresets() }));

app.post<{ Body: { name: string; style: string; watermark?: boolean; cropMode?: string } }>(
  "/presets",
  async (req) => {
    const { name, style, watermark, cropMode } = req.body ?? {};
    const preset: Preset = {
      id: nanoid(8),
      name: name || "Untitled",
      style: style || "bold",
      watermark: watermark !== false,
      cropMode: cropMode || "center",
      createdAt: new Date().toISOString(),
    };
    savePreset(preset);
    return preset;
  },
);

app.delete<{ Params: { id: string } }>(
  "/presets/:id",
  async (req, reply) => {
    if (!deletePreset(req.params.id))
      return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  },
);

// ----- live events (SSE) — inbox watcher + job updates -----

app.get("/events", async (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  const sendEvent = (data: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Subscribe to inbox events
  const unsub = onInboxEvent((ev) => sendEvent(ev));

  // Keep alive
  const keepAlive = setInterval(() => {
    reply.raw.write(`: keepalive\n\n`);
  }, 15000);

  req.raw.on("close", () => {
    unsub();
    clearInterval(keepAlive);
  });
});

// ----- static: serve the built studio under / -----

const studioDist = resolve(REPO_ROOT, "studio", "dist");
if (existsSync(studioDist)) {
  // Register a second static plugin for the studio bundle. fastify-static
  // doesn't allow two roots on the same prefix, so we serve it under /app
  // in dev and rely on Vite's own dev server at :5173 for hot reload.
  await app.register(fastifyStatic, {
    root: studioDist,
    prefix: "/app/",
    decorateReply: false,
  });
}

const PORT = Number(process.env.TITLER_STUDIO_PORT ?? 7777);
const HOST = process.env.TITLER_STUDIO_HOST ?? "127.0.0.1";

app.listen({ port: PORT, host: HOST }).then(() => {
  app.log.info(`titler studio listening on http://${HOST}:${PORT}`);
  app.log.info(`  repo root: ${REPO_ROOT}`);
  app.log.info(`  in/: ${IN_DIR}`);
  app.log.info(`  work/: ${WORK_DIR}`);
  app.log.info(`  out/: ${OUT_DIR}`);
  startInboxWatcher();
});
