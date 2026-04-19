import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { TitlerVideo } from "@titler/remotion/src/compositions/TitlerVideo";
import {
  VIDEO_WIDTH,
  VIDEO_HEIGHT,
  VIDEO_FPS,
  type CompositionProps,
  type CaptionStyle,
} from "@titler/remotion/src/types";
import {
  listInbox,
  listProjects,
  createProject,
  getProject,
  deleteProject,
  archiveProject,
  renameProject,
  runStream,
  listJobs,
  submitJob,
  submitBatchImport,
  submitBatchRender,
  clearJobs,
  listOutputs,
  deleteOutput,
  saveOverlays,
  type Project,
  type CropMode,
  type Job,
  type OutputFile,
} from "./api";
import { TranscriptEditor } from "./components/TranscriptEditor";
import { OverlayEditor } from "./components/OverlayEditor";
import { BatchDrawer } from "./components/BatchDrawer";
import { JobsDropdown } from "./components/JobsDropdown";
import { TOKENS, FONTS, fmtTime, type ThemeName, type Tok } from "./tokens";
import {
  Btn,
  DeviceIcon,
  Hairline,
  Icon,
  IconBtn,
  Kbd,
  Pill,
  SectionLabel,
  ToggleChip,
} from "./primitives";

// --- error boundary ---
class ErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div style={{ color: "red", padding: 16, fontSize: 12 }}>
          Player error: {this.state.error.message}
        </div>
      );
    return this.props.children;
  }
}

type LogEntry = { t: number; text: string };

const CAPTION_STYLES: { id: CaptionStyle; name: string; desc: string }[] = [
  { id: "bold", name: "Bold", desc: "word-by-word, caps" },
  { id: "clean", name: "Clean", desc: "phrase, blurred bar" },
  { id: "focus", name: "Focus", desc: "one word, large" },
];

const ASPECTS: { id: CropMode | "blur_fill" | "letterbox"; label: string }[] = [
  { id: "center", label: "9:16 crop" },
  { id: "face_track", label: "face track" },
  { id: "blur_fill", label: "blur fill" },
  { id: "letterbox", label: "letterbox" },
];

const getThemePref = (): ThemeName => {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage?.getItem("titler.theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

const srtTs = (s: number): string => {
  const sign = s < 0 ? 0 : s;
  const ms = Math.round(sign * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const mm = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(mm).padStart(3, "0")}`;
};

const wordsToSrt = (words: { start: number; end: number; text: string }[]): string => {
  // Group into ~8-word cues.
  const chunks: { start: number; end: number; text: string }[] = [];
  const CHUNK = 8;
  for (let i = 0; i < words.length; i += CHUNK) {
    const slice = words.slice(i, i + CHUNK);
    if (!slice.length) continue;
    chunks.push({
      start: slice[0].start,
      end: slice[slice.length - 1].end,
      text: slice.map((w) => w.text).join(" "),
    });
  }
  return chunks
    .map(
      (c, i) =>
        `${i + 1}\n${srtTs(c.start)} --> ${srtTs(c.end)}\n${c.text}\n`,
    )
    .join("\n");
};

// Mirror server/src/renderFfmpeg.ts — `${YYYYMMDD}_${HHMMSS}` from recording time
// (UTC). This is the basename that shows up in out/, so surfacing it in the
// project list lets users correlate to their rendered files.
const outputPrefix = (project: Project): string => {
  const iso =
    project.source?.original.createdAt ?? project.createdAt;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "unknown";
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "_")
    .slice(0, 15);
};

const buildTitle = (words: { text: string }[]): string => {
  const text = words.map((w) => w.text).join(" ");
  const end = text.search(/[.!?]/);
  const first = end > 0 ? text.slice(0, end) : text.slice(0, 80);
  return first.length > 80 ? first.slice(0, 78) + "…" : first + ".";
};

export const App = () => {
  const [theme, setTheme] = useState<ThemeName>(getThemePref);
  const tok = TOKENS[theme];

  useEffect(() => {
    document.body.classList.toggle("theme-dark", theme === "dark");
    document.body.style.background = tok.paper;
    document.body.style.color = tok.ink;
    try {
      localStorage.setItem("titler.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme, tok]);

  const [inbox, setInbox] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<Project | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>("bold");
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [watermark, setWatermark] = useState(true);
  const [showSafeZone, setShowSafeZone] = useState(false);
  const [lastRenderFile, setLastRenderFile] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<OutputFile[]>([]);
  const [outputsKey, setOutputsKey] = useState(0);
  const [batchOpen, setBatchOpen] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const playerRef = useRef<PlayerRef>(null);

  const [jobs, setJobs] = useState<Job[]>([]);

  // Re-transcribe popover
  const [retxOpen, setRetxOpen] = useState(false);
  const [retxLang, setRetxLang] = useState("");
  const [retxPrompt, setRetxPrompt] = useState("");
  const [retxBackend, setRetxBackend] = useState<"" | "mlx" | "faster">("");

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const pushLog = useCallback(
    (text: string) =>
      setLogs((prev) => [...prev.slice(-200), { t: Date.now(), text }]),
    [],
  );

  const refresh = useCallback(async () => {
    const [i, p] = await Promise.all([
      listInbox(),
      listProjects({ archived: showArchived }),
    ]);
    setInbox(i);
    setProjects(p);
  }, [showArchived]);

  useEffect(() => {
    refresh().catch((e) => pushLog(`error: ${(e as Error).message}`));
  }, [refresh, pushLog]);

  useEffect(() => {
    listOutputs().then(setOutputs).catch(() => {});
  }, [outputsKey]);

  // SSE live inbox updates
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const name =
          (data.file as string | undefined)?.split("/").pop() ?? "?";
        if (data.type === "new_file") {
          showToast(`inbox: ${name} detected`);
        } else if (data.type === "project_created") {
          showToast(`imported ${name}`);
          refresh();
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [refresh, showToast]);

  const hasActiveJobs = jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );
  const prevActiveRef = useRef(false);
  useEffect(() => {
    if (prevActiveRef.current && !hasActiveJobs && jobs.length > 0) {
      setOutputsKey((k) => k + 1);
      refresh();
      setCurrent((c) => {
        if (!c) return c;
        const id = c.id;
        getProject(id)
          .then((fresh) => setCurrent((cur) => (cur?.id === id ? fresh : cur)))
          .catch(() => {});
        return c;
      });
    }
    prevActiveRef.current = hasActiveJobs;
  }, [hasActiveJobs, jobs.length, refresh]);

  const prevJobsRef = useRef<Job[]>([]);
  useEffect(() => {
    const prev = prevJobsRef.current;
    for (const j of jobs) {
      const before = prev.find((p) => p.id === j.id);
      if (!before || before.status === j.status) continue;
      const proj = projects.find((p) => p.id === j.projectId);
      const name = proj?.name ?? j.projectId;
      if (j.status === "done") pushLog(`✓ ${name} — ${j.steps.join("+")} done`);
      else if (j.status === "error") pushLog(`✗ ${name} — ${j.error ?? "failed"}`);
    }
    prevJobsRef.current = jobs;
  }, [jobs, projects, pushLog]);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const interval = setInterval(async () => {
      try {
        const { jobs: fresh } = await listJobs();
        setJobs(fresh);
        const [i, p] = await Promise.all([
          listInbox(),
          listProjects({ archived: showArchived }),
        ]);
        setInbox(i);
        setProjects(p);
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [hasActiveJobs, showArchived]);

  // Track playback time + playing state
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = () =>
      setCurrentTime(player.getCurrentFrame() / VIDEO_FPS);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    player.addEventListener("frameupdate", onFrame as any);
    player.addEventListener("play", onPlay as any);
    player.addEventListener("pause", onPause as any);
    return () => {
      player.removeEventListener("frameupdate", onFrame as any);
      player.removeEventListener("play", onPlay as any);
      player.removeEventListener("pause", onPause as any);
    };
  }, [current]);

  // keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const player = playerRef.current;
      if (!player) return;
      switch (e.code) {
        case "Space": {
          e.preventDefault();
          if (player.isPlaying()) player.pause();
          else player.play();
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          const offset = e.shiftKey ? VIDEO_FPS * 5 : VIDEO_FPS;
          player.seekTo(Math.max(0, player.getCurrentFrame() - offset));
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          const offset = e.shiftKey ? VIDEO_FPS * 5 : VIDEO_FPS;
          player.seekTo(player.getCurrentFrame() + offset);
          break;
        }
        case "Escape":
          setCurrent(null);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // --- single project actions ---

  const onPickInbox = async (file: string) => {
    setBusy(true);
    try {
      pushLog(`creating project for ${file}`);
      const project = await createProject(file);
      await refresh();
      setCurrent(project);
      await runStream(`/projects/${project.id}/ingest`, () => {});
      const ingested = await getProject(project.id);
      setCurrent(ingested);
      await runStream(`/projects/${project.id}/transcribe`, () => {});
      const final = await getProject(project.id);
      setCurrent(final);
      await refresh();
      showToast(`transcribed · ${final.transcript?.words.length ?? 0} words`);
    } catch (e) {
      pushLog(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onPickProject = async (id: string) => {
    try {
      const p = await getProject(id);
      setCurrent(p);
      setCurrentTime(0);
    } catch (e) {
      pushLog(`error loading project: ${(e as Error).message}`);
    }
  };

  const onSeek = useCallback((time: number) => {
    const player = playerRef.current;
    if (!player) return;
    const frame = Math.round(time * VIDEO_FPS);
    player.seekTo(frame);
    player.play();
    setTimeout(() => {
      try {
        player.pause();
      } catch {
        /* unmounted */
      }
    }, 1000);
  }, []);

  const onPause = useCallback(() => {
    try {
      playerRef.current?.pause();
    } catch {
      /* unmounted */
    }
  }, []);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.isPlaying()) player.pause();
    else player.play();
  }, []);

  const seekBy = useCallback((seconds: number) => {
    const player = playerRef.current;
    if (!player) return;
    const f = player.getCurrentFrame() + Math.round(seconds * VIDEO_FPS);
    player.seekTo(Math.max(0, f));
  }, []);

  const onRender = useCallback(async () => {
    if (!current) return;
    setRendering(true);
    setRenderProgress(0);
    showToast(`rendering ${captionStyle}…`);
    try {
      let outputPath = "";
      await runStream(
        `/projects/${current.id}/render?style=${captionStyle}&watermark=${watermark}`,
        (ev) => {
          const d = ev as Record<string, unknown>;
          if (typeof d.percent === "number") {
            setRenderProgress(Math.round(d.percent));
          } else if (typeof d.progress === "string") {
            const m = /(\d+)\s*%/.exec(d.progress);
            if (m) setRenderProgress(parseInt(m[1], 10));
          }
          if (d.phase === "done" && typeof d.outputPath === "string") {
            outputPath = d.outputPath;
          }
        },
      );
      if (outputPath) {
        const fileName = outputPath.split("/").pop() ?? "";
        setLastRenderFile(fileName);
        showToast(`rendered ${fileName}`);
      } else {
        showToast("render complete");
      }
      setRenderProgress(100);
      setOutputsKey((k) => k + 1);
      try {
        const fresh = await getProject(current.id);
        setCurrent((c) => (c?.id === fresh.id ? fresh : c));
      } catch {
        /* ignore */
      }
      refresh().catch(() => {});
    } catch (e) {
      pushLog(`render error: ${(e as Error).message}`);
      showToast(`render failed: ${(e as Error).message}`);
    } finally {
      setRendering(false);
    }
  }, [current, captionStyle, watermark, showToast, pushLog, refresh]);

  const saveWords = useCallback(
    async (projectId: string, words: import("./api").Word[]) => {
      try {
        await fetch(`/api/projects/${projectId}/transcript`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ words }),
        });
        setCurrent((c) =>
          c && c.id === projectId ? { ...c, edited: true } : c,
        );
        setProjects((ps) =>
          ps.map((p) => (p.id === projectId ? { ...p, edited: true } : p)),
        );
      } catch (e) {
        pushLog(`save error: ${(e as Error).message}`);
      }
    },
    [pushLog],
  );

  const onEditWord = useCallback(
    async (index: number, newText: string) => {
      if (!current?.transcript) return;
      const words = [...current.transcript.words];
      words[index] = { ...words[index], text: newText };
      setCurrent({ ...current, transcript: { ...current.transcript, words } });
      await saveWords(current.id, words);
    },
    [current, saveWords],
  );

  const onDeleteWord = useCallback(
    async (index: number) => {
      if (!current?.transcript) return;
      const words = current.transcript.words.filter((_, i) => i !== index);
      setCurrent({ ...current, transcript: { ...current.transcript, words } });
      await saveWords(current.id, words);
    },
    [current, saveWords],
  );

  const onDeleteWords = useCallback(
    async (indices: number[]) => {
      if (!current?.transcript || indices.length === 0) return;
      const drop = new Set(indices);
      const words = current.transcript.words.filter((_, i) => !drop.has(i));
      setCurrent({ ...current, transcript: { ...current.transcript, words } });
      await saveWords(current.id, words);
    },
    [current, saveWords],
  );

  const onClearTranscript = useCallback(async () => {
    if (!current?.transcript) return;
    if (!confirm("Clear all subtitles? This empties the transcript.")) return;
    const cleared = { ...current.transcript, words: [] as import("./api").Word[] };
    setCurrent({ ...current, transcript: cleared });
    await saveWords(current.id, []);
    showToast("subtitles cleared");
  }, [current, saveWords, showToast]);

  const onInsertWord = useCallback(
    async (afterIndex: number, text: string) => {
      if (!current?.transcript) return;
      const words = [...current.transcript.words];
      const totalChars = words.reduce((s, w) => s + Math.max(1, w.text.length), 0);
      const totalDur = words.reduce((s, w) => s + Math.max(0, w.end - w.start), 0);
      const secPerChar =
        totalChars > 0 && totalDur > 0 ? totalDur / totalChars : 0.08;
      const desiredDur = Math.max(0.4, Math.min(2.0, text.length * secPerChar));
      const prevEnd = afterIndex >= 0 ? words[afterIndex]?.end ?? 0 : 0;
      const nextStart = words[afterIndex + 1]?.start ?? currentTime + desiredDur;
      let start = Math.max(prevEnd + 0.01, currentTime - desiredDur * 0.25);
      let end = start + desiredDur;
      if (nextStart - start >= 0.25 && end > nextStart - 0.01)
        end = nextStart - 0.01;
      const newWord: import("./api").Word = { start, end, text, prob: 1 };
      words.splice(afterIndex + 1, 0, newWord);
      setCurrent({ ...current, transcript: { ...current.transcript, words } });
      await saveWords(current.id, words);
    },
    [current, saveWords, currentTime],
  );

  const onOverlaysChange = useCallback(
    async (overlays: import("./api").TextOverlay[]) => {
      if (!current) return;
      setCurrent({ ...current, overlays });
      try {
        await saveOverlays(current.id, overlays);
      } catch (e) {
        pushLog(`overlay save error: ${(e as Error).message}`);
      }
    },
    [current, pushLog],
  );

  const onChangeAspect = useCallback(
    async (id: string) => {
      if (!current) return;
      // Only center/face_track are reingest-ready here.
      if (id !== "center" && id !== "face_track") {
        showToast(`${id} not yet wired`);
        return;
      }
      const mode = id as CropMode;
      setBusy(true);
      try {
        if (mode === "face_track" && !current.faceTrack) {
          await runStream(`/projects/${current.id}/face-track`, () => {});
        }
        await runStream(
          `/projects/${current.id}/reingest`,
          () => {},
          { body: { cropMode: mode } },
        );
        const updated = await getProject(current.id);
        setCurrent(updated);
        await refresh();
        showToast(`crop · ${mode}`);
      } catch (e) {
        showToast(`crop failed: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [current, refresh, showToast],
  );

  const onRenameProject = useCallback(async () => {
    if (!current) return;
    const name = prompt("Rename project:", current.name);
    if (!name || name === current.name) return;
    try {
      await renameProject(current.id, name);
      setCurrent({ ...current, name });
      await refresh();
    } catch (e) {
      showToast(`rename failed: ${(e as Error).message}`);
    }
  }, [current, refresh, showToast]);

  const onDeleteProject = useCallback(async () => {
    if (!current) return;
    if (!confirm(`Delete "${current.name}"?`)) return;
    try {
      await deleteProject(current.id);
      setCurrent(null);
      await refresh();
      showToast("deleted");
    } catch (e) {
      showToast(`delete failed: ${(e as Error).message}`);
    }
  }, [current, refresh, showToast]);

  const onArchiveProject = useCallback(async () => {
    if (!current) return;
    try {
      await archiveProject(current.id);
      setCurrent(null);
      await refresh();
      showToast(current.archived ? "unarchived" : "archived");
    } catch (e) {
      showToast(`archive failed: ${(e as Error).message}`);
    }
  }, [current, refresh, showToast]);

  const onReTranscribe = useCallback(
    async () => {
      if (!current) return;
      const msg = current.edited
        ? "Re-transcribe from scratch? Manual edits will be lost."
        : "Re-transcribe from scratch?";
      if (!confirm(msg)) return;
      try {
        await submitJob(current.id, ["transcribe"], undefined, {
          language: retxLang || undefined,
          initialPrompt: retxPrompt || undefined,
          backend: retxBackend || undefined,
        });
        const { jobs: fresh } = await listJobs();
        setJobs(fresh);
        showToast(`re-transcribe queued`);
        setRetxOpen(false);
      } catch (e) {
        showToast(`failed: ${(e as Error).message}`);
      }
    },
    [current, retxLang, retxPrompt, retxBackend, showToast],
  );

  // --- batch ---

  const runBatch = async (files: string[], withRender: boolean) => {
    setBatchOpen(false);
    if (files.length === 0) return;
    try {
      const style = withRender ? captionStyle : undefined;
      const { results } = await submitBatchImport(files, style);
      const ok = results.filter((r) => r.projectId).length;
      const fail = results.filter((r) => r.error).length;
      const action = withRender ? "import+render" : "import";
      showToast(`queued ${ok} ${action}${fail ? ` (${fail} failed)` : ""}`);
      const { jobs: fresh } = await listJobs();
      setJobs(fresh);
      await refresh();
    } catch (e) {
      showToast(`batch failed: ${(e as Error).message}`);
    }
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedProjects(new Set()), []);

  const onBatchRenderSelected = async () => {
    if (selectedProjects.size === 0) return;
    const ids = [...selectedProjects];
    setSelectedProjects(new Set());
    try {
      const { jobs: newJobs, skipped } = await submitBatchRender(
        ids,
        captionStyle,
      );
      const skipMsg = skipped.length ? ` (${skipped.length} skipped)` : "";
      showToast(`queued ${newJobs.length} renders · ${captionStyle}${skipMsg}`);
      const { jobs: fresh } = await listJobs();
      setJobs(fresh);
    } catch (e) {
      showToast(`batch render failed: ${(e as Error).message}`);
    }
  };

  const onBatchArchiveSelected = async () => {
    if (selectedProjects.size === 0) return;
    const ids = [...selectedProjects];
    setSelectedProjects(new Set());
    for (const id of ids) {
      try {
        await archiveProject(id);
      } catch (e) {
        pushLog(`archive error: ${(e as Error).message}`);
      }
    }
    if (current && ids.includes(current.id)) setCurrent(null);
    await refresh();
    showToast(`archived ${ids.length} project${ids.length === 1 ? "" : "s"}`);
  };

  const onBatchDeleteSelected = async () => {
    if (selectedProjects.size === 0) return;
    const n = selectedProjects.size;
    if (!confirm(`Delete ${n} project${n === 1 ? "" : "s"}?`)) return;
    const ids = [...selectedProjects];
    setSelectedProjects(new Set());
    for (const id of ids) {
      try {
        await deleteProject(id);
      } catch (e) {
        pushLog(`delete error: ${(e as Error).message}`);
      }
    }
    if (current && ids.includes(current.id)) setCurrent(null);
    await refresh();
    showToast(`deleted ${n} project${n === 1 ? "" : "s"}`);
  };

  const renderAllReady = async () => {
    const ready = projects
      .filter((p) => p.transcript && !(p.rendered?.length ?? 0))
      .map((p) => p.id);
    if (ready.length === 0) {
      showToast("no projects ready to render");
      return;
    }
    try {
      const { jobs: newJobs, skipped } = await submitBatchRender(
        ready,
        captionStyle,
      );
      const skipMsg = skipped.length ? ` (${skipped.length} skipped)` : "";
      showToast(
        `queued ${newJobs.length} renders · ${captionStyle}${skipMsg}`,
      );
      const { jobs: fresh } = await listJobs();
      setJobs(fresh);
    } catch (e) {
      showToast(`batch render failed: ${(e as Error).message}`);
    }
  };

  // --- player props ---

  const playerProps: CompositionProps = useMemo(() => {
    const sourceUrl = current?.source
      ? `/api/projects/${current.id}/source.mp4`
      : "";
    const duration =
      current?.source?.original.duration ??
      current?.transcript?.duration ??
      10;
    return {
      sourceUrl,
      transcript: current?.transcript ?? null,
      durationInSeconds: duration,
      circle: current?.source?.circle ?? null,
      style: captionStyle,
      showSafeZone,
      overlays: current?.overlays ?? [],
    };
  }, [current, captionStyle, showSafeZone]);

  const durationInFrames = Math.max(
    1,
    Math.round(playerProps.durationInSeconds * VIDEO_FPS),
  );
  const totalDuration = playerProps.durationInSeconds;

  const words = current?.transcript?.words ?? [];
  const lowConf = words.filter((w) => (w.prob ?? 1) < 0.75).length;
  // --- Project rail grouping ---
  const sortedProjects = useMemo(
    () =>
      [...projects].sort((a, b) => {
        const ta = new Date(a.source?.original.createdAt ?? a.createdAt).getTime();
        const tb = new Date(b.source?.original.createdAt ?? b.createdAt).getTime();
        return tb - ta;
      }),
    [projects],
  );

  const startOfToday = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);
  const todayProjects = sortedProjects.filter((p) => {
    const t = new Date(p.source?.original.createdAt ?? p.createdAt).getTime();
    return t >= startOfToday;
  });
  const earlierProjects = sortedProjects.filter((p) => {
    const t = new Date(p.source?.original.createdAt ?? p.createdAt).getTime();
    return t < startOfToday;
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: tok.paper,
        color: tok.ink,
        fontFamily: FONTS.body,
        display: "grid",
        gridTemplateColumns: "280px 1fr 360px",
        overflow: "hidden",
      }}
    >
      {/* LEFT RAIL */}
      <aside
        style={{
          borderRight: `1px solid ${tok.rule}`,
          padding: "24px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          overflowY: "auto",
          minHeight: 0,
        }}
      >
        {/* Brand + theme */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              background: tok.ink,
              display: "grid",
              placeItems: "center",
              color: tok.paper,
              fontFamily: FONTS.display,
              fontStyle: "italic",
              fontWeight: 600,
              fontSize: 17,
              letterSpacing: -0.5,
            }}
          >
            T
          </div>
          <div
            style={{
              fontFamily: FONTS.display,
              fontWeight: 500,
              fontStyle: "italic",
              fontSize: 22,
              letterSpacing: -0.5,
              color: tok.ink,
            }}
          >
            Titler
          </div>
          <div style={{ flex: 1 }} />
          <IconBtn
            name={theme === "light" ? "moon" : "sun"}
            tok={tok}
            size={28}
            iconSize={14}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            title="Toggle theme"
          />
          <IconBtn
            name="refresh"
            tok={tok}
            size={28}
            iconSize={14}
            onClick={() => {
              setOutputsKey((k) => k + 1);
              refresh();
            }}
            title="Refresh"
          />
        </div>

        {/* Search (static) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 12px",
            background: tok.sunk,
            borderRadius: 6,
            fontSize: 12.5,
            color: tok.ink3,
          }}
        >
          <Icon name="search" size={14} />
          <span style={{ flex: 1 }}>search transcripts…</span>
          <Kbd tok={tok}>⌘K</Kbd>
        </div>

        {/* Inbox */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <SectionLabel tok={tok}>Inbox · {inbox.length} new</SectionLabel>
            {inbox.length > 0 && (
              <button
                onClick={() => setBatchOpen(true)}
                style={{
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                  color: tok.accentInk,
                  fontFamily: FONTS.body,
                  fontSize: 10.5,
                  fontWeight: 500,
                  padding: 0,
                  textTransform: "uppercase",
                  letterSpacing: 0.1,
                }}
              >
                import all →
              </button>
            )}
          </div>
          {inbox.length === 0 && (
            <div
              style={{
                fontFamily: FONTS.display,
                fontStyle: "italic",
                fontSize: 12,
                color: tok.ink3,
                padding: "6px 2px",
              }}
            >
              No new files.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {inbox.slice(0, 6).map((f) => {
              const name = f.split("/").pop() ?? f;
              return (
                <div
                  key={f}
                  onClick={() => !busy && onPickInbox(f)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 10px",
                    borderRadius: 6,
                    background: tok.card,
                    border: `1px solid ${tok.ruleSoft}`,
                    cursor: busy ? "wait" : "pointer",
                    transition: "all 0.12s ease",
                  }}
                  title={name}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: tok.accent,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        color: tok.ink,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {name}
                    </div>
                  </div>
                  <Icon name="arrowRight" size={12} color={tok.ink3} />
                </div>
              );
            })}
            {inbox.length > 6 && (
              <button
                onClick={() => setBatchOpen(true)}
                style={{
                  fontSize: 11,
                  color: tok.ink3,
                  padding: "4px 10px",
                  textAlign: "left",
                  fontFamily: FONTS.body,
                }}
              >
                + {inbox.length - 6} more…
              </button>
            )}
          </div>
        </div>

        {/* Projects */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <SectionLabel tok={tok}>Projects</SectionLabel>
            <label
              style={{
                fontFamily: FONTS.body,
                fontSize: 10.5,
                color: tok.ink3,
                display: "flex",
                alignItems: "center",
                gap: 4,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={showArchived}
                onChange={() => setShowArchived(!showArchived)}
                style={{ accentColor: tok.ink }}
              />
              archived
            </label>
          </div>
          {todayProjects.length > 0 && (
            <ProjectGroup
              tok={tok}
              title="Today"
              projects={todayProjects}
              currentId={current?.id}
              jobs={jobs}
              onPick={onPickProject}
              selected={selectedProjects}
              onToggleSelect={toggleSelect}
            />
          )}
          {todayProjects.length > 0 && earlierProjects.length > 0 && (
            <div style={{ height: 14 }} />
          )}
          {earlierProjects.length > 0 && (
            <ProjectGroup
              tok={tok}
              title="Earlier"
              projects={earlierProjects}
              currentId={current?.id}
              jobs={jobs}
              onPick={onPickProject}
              selected={selectedProjects}
              onToggleSelect={toggleSelect}
            />
          )}
          {projects.length === 0 && (
            <div
              style={{
                fontFamily: FONTS.display,
                fontStyle: "italic",
                fontSize: 12,
                color: tok.ink3,
                padding: "6px 2px",
              }}
            >
              No projects yet.
            </div>
          )}
        </div>

        {/* Outputs */}
        {outputs.length > 0 && (
          <div>
            <SectionLabel tok={tok} style={{ marginBottom: 6 }}>
              Outputs · {outputs.length}
            </SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {outputs.slice(0, 4).map((f) => (
                <div
                  key={f.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 8px",
                    borderRadius: 4,
                    fontSize: 11,
                  }}
                >
                  <Icon name="file" size={12} color={tok.ink3} />
                  <a
                    href={`/api/out/${encodeURIComponent(f.name)}`}
                    download
                    style={{
                      flex: 1,
                      color: tok.ink2,
                      textDecoration: "none",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontFamily: FONTS.mono,
                      fontSize: 10.5,
                    }}
                    title={f.name}
                  >
                    {f.name}
                  </a>
                  <button
                    onClick={async () => {
                      if (!confirm(`Delete ${f.name}?`)) return;
                      await deleteOutput(f.name);
                      setOutputsKey((k) => k + 1);
                    }}
                    title="delete"
                    style={{ color: tok.ink4 }}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer: batch + jobs indicator */}
        <div
          style={{
            marginTop: "auto",
            paddingTop: 14,
            borderTop: `1px solid ${tok.ruleSoft}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Btn
            tok={tok}
            variant="outline"
            size="sm"
            icon="batch"
            onClick={() => setBatchOpen(true)}
          >
            Batch
          </Btn>
          <JobsDropdown
            tok={tok}
            jobs={jobs}
            projects={projects}
            onClear={async () => {
              await clearJobs();
              const { jobs: fresh } = await listJobs();
              setJobs(fresh);
            }}
          />
          <div style={{ flex: 1 }} />
          <div
            style={{
              fontFamily: FONTS.mono,
              fontSize: 10,
              color: tok.ink3,
            }}
          >
            :7777
          </div>
        </div>
      </aside>

      {/* CENTER — manuscript */}
      <main
        style={{
          padding: "28px 6vw 20px",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        {current ? (
          <ManuscriptPane
            tok={tok}
            current={current}
            words={words}
            lowConf={lowConf}
            totalDuration={totalDuration}
            onReTranscribe={() => setRetxOpen((v) => !v)}
            retxOpen={retxOpen}
            retxLang={retxLang}
            retxPrompt={retxPrompt}
            retxBackend={retxBackend}
            setRetxLang={setRetxLang}
            setRetxPrompt={setRetxPrompt}
            setRetxBackend={setRetxBackend}
            runReTranscribe={onReTranscribe}
            onRename={onRenameProject}
            onArchive={onArchiveProject}
            onDelete={onDeleteProject}
            onSeek={onSeek}
            onPause={onPause}
            onEdit={onEditWord}
            onDeleteWord={onDeleteWord}
            onDeleteWords={onDeleteWords}
            onClearSubs={onClearTranscript}
            onInsert={onInsertWord}
            captionStyle={captionStyle}
            setCaptionStyle={setCaptionStyle}
            watermark={watermark}
            setWatermark={setWatermark}
            showSafeZone={showSafeZone}
            setShowSafeZone={setShowSafeZone}
            rendering={rendering}
            renderProgress={renderProgress}
            onRender={onRender}
            currentTime={currentTime}
            jobs={jobs}
            onQueueIngest={async () => {
              try {
                await submitJob(current.id, ["ingest", "transcribe"]);
                const { jobs: fresh } = await listJobs();
                setJobs(fresh);
                showToast(`queued ingest + transcribe`);
              } catch (e) {
                showToast(`failed: ${(e as Error).message}`);
              }
            }}
          />
        ) : (
          <EmptyManuscript
            tok={tok}
            inbox={inbox}
            onBatch={() => setBatchOpen(true)}
            onRenderAll={renderAllReady}
            canRenderAll={projects.some(
              (p) => p.transcript && !(p.rendered?.length ?? 0),
            )}
          />
        )}
      </main>

      {/* RIGHT — preview */}
      <aside
        style={{
          borderLeft: `1px solid ${tok.rule}`,
          background: tok.sunk,
          padding: "24px 22px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          overflowY: "auto",
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <SectionLabel tok={tok}>Preview</SectionLabel>
          <div
            style={{
              fontFamily: FONTS.mono,
              fontSize: 10,
              color: tok.ink3,
            }}
          >
            {VIDEO_WIDTH} × {VIDEO_HEIGHT}
          </div>
        </div>

        {/* Phone frame with real Remotion player */}
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: 240,
              aspectRatio: "9/16",
              background: "#000",
              borderRadius: 18,
              overflow: "hidden",
              border: "6px solid #0a0a0a",
              boxShadow:
                "0 1px 2px rgba(0,0,0,0.1), 0 20px 60px -20px rgba(0,0,0,0.4)",
              boxSizing: "border-box",
            }}
          >
            {current?.source ? (
              <ErrorBoundary
                fallback={
                  <div
                    style={{
                      color: tok.err,
                      padding: 12,
                      fontSize: 11,
                    }}
                  >
                    player crashed
                  </div>
                }
              >
                <Player
                  ref={playerRef}
                  component={TitlerVideo}
                  inputProps={playerProps}
                  durationInFrames={durationInFrames}
                  compositionWidth={VIDEO_WIDTH}
                  compositionHeight={VIDEO_HEIGHT}
                  fps={VIDEO_FPS}
                  style={{ width: "100%", height: "100%" }}
                  acknowledgeRemotionLicense
                />
              </ErrorBoundary>
            ) : (
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  display: "grid",
                  placeItems: "center",
                  color: "#666",
                  fontFamily: FONTS.display,
                  fontStyle: "italic",
                  fontSize: 12,
                  textAlign: "center",
                  padding: 16,
                }}
              >
                no source
              </div>
            )}
          </div>
        </div>

        {/* Scrubber */}
        <div>
          <div
            style={{ position: "relative", height: 22, cursor: "pointer" }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const f = (e.clientX - rect.left) / rect.width;
              const time = Math.max(
                0,
                Math.min(totalDuration, f * totalDuration),
              );
              const player = playerRef.current;
              if (player) player.seekTo(Math.round(time * VIDEO_FPS));
              setCurrentTime(time);
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 10,
                left: 0,
                right: 0,
                height: 2,
                background: tok.rule,
                borderRadius: 2,
              }}
            />
            <div
              style={{
                position: "absolute",
                top: 10,
                left: 0,
                width: `${totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0}%`,
                height: 2,
                background: tok.ink,
                borderRadius: 2,
              }}
            />
            <div
              style={{
                position: "absolute",
                top: 5,
                left: `${totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0}%`,
                width: 12,
                height: 12,
                background: tok.ink,
                borderRadius: 999,
                transform: "translateX(-50%)",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 2,
              fontFamily: FONTS.mono,
              fontSize: 10.5,
              color: tok.ink3,
            }}
          >
            <span>{fmtTime(currentTime)}</span>
            <span>{fmtTime(totalDuration)}</span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 8,
          }}
        >
          <IconBtn
            name="chevron"
            tok={tok}
            size={32}
            iconSize={14}
            style={{ transform: "rotate(180deg)" }}
            title="back 5s"
            onClick={() => seekBy(-5)}
          />
          <IconBtn
            name={isPlaying ? "pause" : "play"}
            tok={tok}
            size={44}
            iconSize={20}
            style={{ background: tok.ink, color: tok.paper }}
            onClick={togglePlay}
          />
          <IconBtn
            name="chevron"
            tok={tok}
            size={32}
            iconSize={14}
            title="forward 5s"
            onClick={() => seekBy(5)}
          />
        </div>

        {/* Caption style cards */}
        <div>
          <SectionLabel tok={tok}>Caption style</SectionLabel>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 8,
              marginTop: 6,
            }}
          >
            {CAPTION_STYLES.map((s) => (
              <button
                key={s.id}
                onClick={() => setCaptionStyle(s.id)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: 8,
                  border: `1px solid ${captionStyle === s.id ? tok.ink : tok.rule}`,
                  background:
                    captionStyle === s.id ? tok.card : "transparent",
                  borderRadius: 6,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: FONTS.body,
                  transition: "all 0.12s ease",
                }}
              >
                <div
                  style={{
                    width: "100%",
                    aspectRatio: "9/16",
                    background: "#111",
                    borderRadius: 4,
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  <StyleThumbnail styleId={s.id} />
                </div>
                <div
                  style={{
                    fontFamily: FONTS.display,
                    fontStyle: "italic",
                    fontWeight: 500,
                    fontSize: 12.5,
                    color: tok.ink,
                    letterSpacing: -0.1,
                  }}
                >
                  {s.name}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Aspect */}
        {current?.source && (
          <div>
            <SectionLabel tok={tok}>Aspect · crop</SectionLabel>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 4,
                marginTop: 6,
              }}
            >
              {ASPECTS.map((x) => {
                const selected =
                  (x.id === "center" && current?.cropMode !== "face_track") ||
                  (x.id === "face_track" && current?.cropMode === "face_track") ||
                  (x.id === current?.source?.aspectStrategy);
                return (
                  <button
                    key={x.id}
                    onClick={() => onChangeAspect(x.id)}
                    disabled={busy}
                    style={{
                      padding: "7px 10px",
                      borderRadius: 4,
                      fontFamily: FONTS.body,
                      border: `1px solid ${selected ? tok.ink : tok.rule}`,
                      background: selected ? tok.card : "transparent",
                      color: selected ? tok.ink : tok.ink3,
                      fontSize: 12,
                      cursor: busy ? "wait" : "pointer",
                      textAlign: "left",
                      fontWeight: selected ? 500 : 400,
                    }}
                  >
                    {x.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Overlays */}
        {current?.source && (
          <div>
            <SectionLabel tok={tok}>Overlays</SectionLabel>
            <div style={{ marginTop: 6 }}>
              <OverlayEditor
                overlays={current.overlays ?? []}
                currentTime={currentTime}
                duration={totalDuration}
                onChange={onOverlaysChange}
              />
            </div>
          </div>
        )}

        {lastRenderFile && !rendering && (
          <div
            style={{
              marginTop: "auto",
              padding: "12px 14px",
              border: `1px solid ${tok.ok}`,
              borderRadius: 6,
              background: tok.okSoft,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Icon name="check" size={14} color={tok.ok} />
            <div style={{ flex: 1, fontSize: 12, color: tok.ink }}>
              <div style={{ fontWeight: 600 }}>Rendered</div>
              <div
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 10,
                  color: tok.ink3,
                }}
              >
                {lastRenderFile}
              </div>
            </div>
            <a
              href={`/api/out/${encodeURIComponent(lastRenderFile)}`}
              download
              style={{
                color: tok.ink2,
                display: "inline-flex",
                alignItems: "center",
                padding: 4,
              }}
            >
              <Icon name="download" size={14} />
            </a>
          </div>
        )}
      </aside>

      {batchOpen && (
        <BatchDrawer
          tok={tok}
          inbox={inbox}
          captionStyle={captionStyle}
          watermark={watermark}
          onClose={() => setBatchOpen(false)}
          onRun={runBatch}
        />
      )}

      {selectedProjects.size > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px 8px 18px",
            background: tok.ink,
            color: tok.paper,
            borderRadius: 999,
            boxShadow: "0 12px 32px -12px rgba(0,0,0,0.45)",
            fontFamily: FONTS.body,
            zIndex: 90,
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>
            {selectedProjects.size} selected
          </div>
          <div
            style={{
              width: 1,
              height: 20,
              background: "rgba(255,255,255,0.15)",
              margin: "0 4px",
            }}
          />
          <Btn
            tok={tok}
            variant="accent"
            size="sm"
            icon="render"
            onClick={onBatchRenderSelected}
          >
            Render ({captionStyle})
          </Btn>
          <button
            onClick={onBatchArchiveSelected}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              height: 28,
              borderRadius: 999,
              color: tok.paper,
              background: "transparent",
              border: `1px solid rgba(255,255,255,0.2)`,
              fontFamily: FONTS.body,
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <Icon name="archive" size={13} />
            Archive
          </button>
          <button
            onClick={onBatchDeleteSelected}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              height: 28,
              borderRadius: 999,
              color: "oklch(0.78 0.14 25)",
              background: "transparent",
              border: `1px solid rgba(255,255,255,0.2)`,
              fontFamily: FONTS.body,
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <Icon name="trash" size={13} />
            Delete
          </button>
          <button
            onClick={clearSelection}
            title="Clear selection"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: 999,
              color: tok.paper,
              background: "transparent",
              cursor: "pointer",
              opacity: 0.7,
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "10px 18px",
            background: tok.ink,
            color: tok.paper,
            fontSize: 12.5,
            borderRadius: 999,
            fontWeight: 500,
            boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
            fontFamily: FONTS.body,
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Icon name="check" size={12} />
          {toast}
        </div>
      )}

      {/* Recent logs — bottom-left, quiet */}
      {logs.length > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: 12,
            left: 16,
            maxWidth: 240,
            fontFamily: FONTS.mono,
            fontSize: 10,
            color: tok.ink4,
            pointerEvents: "none",
            lineHeight: 1.5,
            textShadow: `0 0 6px ${tok.paper}`,
          }}
        >
          {logs.slice(-2).map((l) => (
            <div
              key={l.t + l.text}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ---- subcomponents ----

const ProjectGroup: React.FC<{
  tok: Tok;
  title: string;
  projects: Project[];
  currentId?: string;
  jobs: Job[];
  onPick: (id: string) => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
}> = ({ tok, title, projects, currentId, jobs, onPick, selected, onToggleSelect }) => (
  <div>
    <div
      style={{
        fontFamily: FONTS.mono,
        fontSize: 9.5,
        color: tok.ink4,
        textTransform: "uppercase",
        letterSpacing: 0.12,
        marginBottom: 4,
        fontWeight: 500,
      }}
    >
      {title}
    </div>
    {projects.map((p) => (
      <ProjectRow
        key={p.id}
        tok={tok}
        project={p}
        active={currentId === p.id}
        jobs={jobs}
        onPick={() => onPick(p.id)}
        selected={selected.has(p.id)}
        onToggleSelect={() => onToggleSelect(p.id)}
      />
    ))}
  </div>
);

const ProjectRow: React.FC<{
  tok: Tok;
  project: Project;
  active: boolean;
  jobs: Job[];
  onPick: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}> = ({ tok, project, active, jobs, onPick, selected, onToggleSelect }) => {
  const [hover, setHover] = useState(false);
  const [avatarHover, setAvatarHover] = useState(false);
  const device = project.source?.original.device ?? "";
  const rec = project.source?.original.createdAt ?? project.createdAt;
  const dur = project.source?.original.duration ?? 0;
  const activeJob = jobs.find(
    (j) =>
      j.projectId === project.id &&
      (j.status === "running" || j.status === "queued"),
  );
  const errorJob = !activeJob
    ? jobs.find((j) => j.projectId === project.id && j.status === "error")
    : undefined;
  const rendered = (project.rendered?.length ?? 0) > 0;
  const hasSource = !!project.source;
  const hasTranscript = !!project.transcript && (project.transcript.words?.length ?? 0) > 0;
  const needsIngest = !activeJob && !errorJob && !hasSource;
  const needsTranscribe = !activeJob && !errorJob && hasSource && !hasTranscript;

  return (
    <div
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        marginLeft: -10,
        marginRight: -10,
        borderLeft: `2px solid ${active ? tok.accent : selected ? tok.accentSoft : "transparent"}`,
        background: selected
          ? tok.accentSoft
          : active
            ? tok.card
            : hover
              ? tok.sunk
              : "transparent",
        cursor: "pointer",
        transition: "all 0.12s ease",
        borderRadius: 4,
        opacity: project.archived ? 0.55 : 1,
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        onMouseEnter={(e) => {
          e.stopPropagation();
          setAvatarHover(true);
        }}
        onMouseLeave={() => setAvatarHover(false)}
        title={selected ? "Deselect" : "Select for batch"}
        style={{
          width: 20,
          height: 20,
          display: "grid",
          placeItems: "center",
          border: `1px solid ${selected ? tok.accent : avatarHover ? tok.ink3 : "transparent"}`,
          background: selected
            ? tok.accent
            : avatarHover
              ? tok.card
              : "transparent",
          borderRadius: 999,
          color: selected
            ? tok.accentFg
            : active
              ? tok.ink2
              : tok.ink3,
          cursor: "pointer",
          transition: "all 0.12s ease",
          flexShrink: 0,
        }}
      >
        {selected ? (
          <Icon name="check" size={12} />
        ) : avatarHover ? (
          <span
            style={{
              width: 10,
              height: 10,
              border: `1.5px solid ${tok.ink3}`,
              borderRadius: 999,
            }}
          />
        ) : (
          <DeviceIcon device={device} size={12} color="currentColor" />
        )}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: FONTS.mono,
            fontSize: 11,
            color: active ? tok.ink : tok.ink2,
            fontWeight: active ? 500 : 400,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            letterSpacing: -0.1,
          }}
          title={outputPrefix(project)}
        >
          {outputPrefix(project)}
          {rendered ? (
            <span style={{ color: tok.ink4 }}>
              _{project.rendered!.length === 1
                ? project.rendered![0].replace(/^.*_/, "").replace(/\.mp4$/, "")
                : "*"}
              .mp4
            </span>
          ) : (
            <span style={{ color: tok.ink4 }}>
              {" "}
              · {Math.max(0, Math.round(dur))}s
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: tok.ink4,
            marginTop: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {new Date(rec).toLocaleString("en", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
          {rendered && ` · ${Math.max(0, Math.round(dur))}s`}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        {activeJob && (
          <Pill
            tok={tok}
            tone="accent"
            style={{ fontSize: 9, padding: "1px 6px" }}
          >
            {activeJob.status === "running"
              ? activeJob.currentStep ?? "running"
              : "queued"}
          </Pill>
        )}
        {errorJob && (
          <span
            title={errorJob.error}
            style={{ color: tok.err, fontSize: 10, fontWeight: 700 }}
          >
            !
          </span>
        )}
        {needsIngest && (
          <Pill
            tok={tok}
            tone="warn"
            style={{ fontSize: 9, padding: "1px 6px" }}
          >
            no ingest
          </Pill>
        )}
        {needsTranscribe && (
          <Pill
            tok={tok}
            tone="warn"
            style={{ fontSize: 9, padding: "1px 6px" }}
          >
            no tx
          </Pill>
        )}
        {!activeJob && !errorJob && rendered && (
          <Icon name="check" size={12} color={tok.ok} />
        )}
        {!activeJob && !errorJob && !rendered && hasTranscript && project.edited && (
          <Pill
            tok={tok}
            tone="accent"
            style={{ fontSize: 9, padding: "1px 6px" }}
          >
            edited
          </Pill>
        )}
      </div>
    </div>
  );
};

const ManuscriptPane: React.FC<{
  tok: Tok;
  current: Project;
  words: import("./api").Word[];
  lowConf: number;
  totalDuration: number;
  currentTime: number;
  onReTranscribe: () => void;
  retxOpen: boolean;
  retxLang: string;
  retxPrompt: string;
  retxBackend: "" | "mlx" | "faster";
  setRetxLang: (s: string) => void;
  setRetxPrompt: (s: string) => void;
  setRetxBackend: (s: "" | "mlx" | "faster") => void;
  runReTranscribe: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onSeek: (t: number) => void;
  onPause: () => void;
  onEdit: (i: number, t: string) => void;
  onDeleteWord: (i: number) => void;
  onDeleteWords: (indices: number[]) => void;
  onClearSubs: () => void;
  onInsert: (afterIndex: number, text: string) => void;
  captionStyle: CaptionStyle;
  setCaptionStyle: (s: CaptionStyle) => void;
  watermark: boolean;
  setWatermark: (v: boolean) => void;
  showSafeZone: boolean;
  setShowSafeZone: (v: boolean) => void;
  rendering: boolean;
  renderProgress: number;
  onRender: () => void;
  jobs: Job[];
  onQueueIngest: () => void;
}> = ({
  tok,
  current,
  words,
  lowConf,
  totalDuration,
  currentTime,
  onReTranscribe,
  retxOpen,
  retxLang,
  retxPrompt,
  retxBackend,
  setRetxLang,
  setRetxPrompt,
  setRetxBackend,
  runReTranscribe,
  onRename,
  onArchive,
  onDelete,
  onSeek,
  onPause,
  onEdit,
  onDeleteWord,
  onDeleteWords,
  onClearSubs,
  onInsert,
  captionStyle,
  setCaptionStyle,
  watermark,
  setWatermark,
  showSafeZone,
  setShowSafeZone,
  rendering,
  renderProgress,
  onRender,
  jobs,
  onQueueIngest,
}) => {
  const device = current.source?.original.device ?? "iPhone";
  const rec = current.source?.original.createdAt ?? current.createdAt;
  const activeJob = jobs.find(
    (j) =>
      j.projectId === current.id &&
      (j.status === "running" || j.status === "queued"),
  );

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 6,
          fontFamily: FONTS.mono,
          fontSize: 10.5,
          color: tok.ink3,
          textTransform: "uppercase",
          letterSpacing: 0.14,
          flexWrap: "wrap",
        }}
      >
        <DeviceIcon device={device} size={12} color={tok.ink3} />
        <span>
          {new Date(rec).toLocaleDateString("en", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </span>
        <span style={{ color: tok.ink4 }}>·</span>
        <span>{device || "video"}</span>
        {totalDuration > 0 && (
          <>
            <span style={{ color: tok.ink4 }}>·</span>
            <span>{fmtTime(totalDuration)}</span>
          </>
        )}
        {words.length > 0 && (
          <>
            <span style={{ color: tok.ink4 }}>·</span>
            <span>{words.length} words</span>
          </>
        )}
        {lowConf > 0 && (
          <>
            <span style={{ color: tok.ink4 }}>·</span>
            <span style={{ color: tok.warn }}>{lowConf} low confidence</span>
          </>
        )}
        <div style={{ flex: 1 }} />
        <Btn tok={tok} variant="quiet" size="sm" icon="wand" onClick={onReTranscribe}>
          re-transcribe
        </Btn>
        {current.transcript && words.length > 0 && (
          <Btn
            tok={tok}
            variant="quiet"
            size="sm"
            icon="trash"
            onClick={onClearSubs}
            title="Empty the transcript"
          >
            clear subs
          </Btn>
        )}
        <Btn tok={tok} variant="quiet" size="sm" icon="edit" onClick={onRename}>
          rename
        </Btn>
        <Btn tok={tok} variant="quiet" size="sm" icon="archive" onClick={onArchive}>
          {current.archived ? "unarchive" : "archive"}
        </Btn>
        <Btn tok={tok} variant="quiet" size="sm" icon="trash" onClick={onDelete}>
          delete
        </Btn>
      </div>

      {retxOpen && (
        <div
          style={{
            marginTop: 6,
            padding: "12px 14px",
            border: `1px solid ${tok.rule}`,
            background: tok.card,
            borderRadius: 6,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            maxWidth: 640,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
            }}
          >
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 11,
                color: tok.ink3,
              }}
            >
              language
              <select
                value={retxLang}
                onChange={(e) => setRetxLang(e.target.value)}
                style={{
                  padding: "6px 8px",
                  border: `1px solid ${tok.rule}`,
                  borderRadius: 4,
                  background: tok.paper,
                  color: tok.ink,
                }}
              >
                <option value="">auto-detect</option>
                <option value="en">English</option>
                <option value="ru">Russian</option>
                <option value="uk">Ukrainian</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="it">Italian</option>
                <option value="pt">Portuguese</option>
                <option value="pl">Polish</option>
                <option value="nl">Dutch</option>
                <option value="ja">Japanese</option>
                <option value="zh">Chinese</option>
                <option value="ko">Korean</option>
                <option value="ar">Arabic</option>
                <option value="tr">Turkish</option>
              </select>
            </label>
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 11,
                color: tok.ink3,
              }}
            >
              backend
              <select
                value={retxBackend}
                onChange={(e) =>
                  setRetxBackend(e.target.value as "" | "mlx" | "faster")
                }
                style={{
                  padding: "6px 8px",
                  border: `1px solid ${tok.rule}`,
                  borderRadius: 4,
                  background: tok.paper,
                  color: tok.ink,
                }}
              >
                <option value="">default (mlx → faster)</option>
                <option value="mlx">mlx (Apple Silicon)</option>
                <option value="faster">faster-whisper</option>
              </select>
            </label>
          </div>
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              fontSize: 11,
              color: tok.ink3,
            }}
          >
            initial prompt (bias vocabulary)
            <textarea
              value={retxPrompt}
              onChange={(e) => setRetxPrompt(e.target.value)}
              rows={2}
              placeholder="names, jargon, language register…"
              style={{
                padding: "6px 8px",
                border: `1px solid ${tok.rule}`,
                borderRadius: 4,
                background: tok.paper,
                color: tok.ink,
                fontFamily: FONTS.body,
                fontSize: 12,
                resize: "vertical",
              }}
            />
          </label>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <Btn tok={tok} variant="outline" size="sm" onClick={onReTranscribe}>
              cancel
            </Btn>
            <Btn tok={tok} variant="accent" size="sm" onClick={runReTranscribe}>
              run
            </Btn>
          </div>
        </div>
      )}

      <h1
        style={{
          fontFamily: FONTS.display,
          fontWeight: 400,
          fontStyle: "italic",
          fontSize: "clamp(26px, 3vw, 38px)",
          letterSpacing: -0.8,
          lineHeight: 1.05,
          margin: "12px 0 18px",
          color: tok.ink,
        }}
      >
        {words.length > 0 ? `"${buildTitle(words)}"` : current.name}
      </h1>

      <Hairline tok={tok} style={{ marginBottom: 20 }} />

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 8px 0 4px",
          minHeight: 0,
        }}
      >
        {current.transcript ? (
          <TranscriptEditor
            tok={tok}
            transcript={current.transcript}
            currentTime={currentTime}
            onSeek={onSeek}
            onPause={onPause}
            onEdit={onEdit}
            onDelete={onDeleteWord}
            onDeleteLine={onDeleteWords}
            onInsert={onInsert}
          />
        ) : (
          <div
            style={{
              padding: "24px 0",
              color: tok.ink3,
              fontFamily: FONTS.display,
              fontStyle: "italic",
              fontSize: 18,
            }}
          >
            {activeJob
              ? `${activeJob.status === "running" ? activeJob.currentStep ?? "running" : "queued"}${activeJob.progress ? ` · ${activeJob.progress}` : ""}…`
              : "not transcribed yet."}
            {!activeJob && (
              <div style={{ marginTop: 14 }}>
                <Btn
                  tok={tok}
                  variant="primary"
                  size="md"
                  icon="wand"
                  onClick={onQueueIngest}
                >
                  start ingest + transcribe
                </Btn>
              </div>
            )}
          </div>
        )}
        <div style={{ height: 120 }} />
      </div>

      <div
        style={{
          marginTop: 12,
          paddingTop: 14,
          borderTop: `1px solid ${tok.ruleSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        {CAPTION_STYLES.map((s) => (
          <button
            key={s.id}
            onClick={() => setCaptionStyle(s.id)}
            style={{
              padding: "7px 14px",
              border: `1px solid ${captionStyle === s.id ? tok.ink : tok.rule}`,
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 500,
              color: captionStyle === s.id ? tok.paper : tok.ink2,
              background: captionStyle === s.id ? tok.ink : "transparent",
              fontFamily: FONTS.body,
              cursor: "pointer",
              transition: "all 0.12s ease",
            }}
          >
            {s.name}
          </button>
        ))}
        <Hairline tok={tok} vertical style={{ height: 22, margin: "0 4px" }} />
        <ToggleChip
          tok={tok}
          label="watermark"
          on={watermark}
          onChange={() => setWatermark(!watermark)}
        />
        <ToggleChip
          tok={tok}
          label="safe zone"
          on={showSafeZone}
          onChange={() => setShowSafeZone(!showSafeZone)}
        />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Btn
            tok={tok}
            variant="outline"
            size="md"
            icon="download"
            onClick={() => {
              if (!current.transcript) return;
              const srt = wordsToSrt(current.transcript.words);
              const blob = new Blob([srt], { type: "text/plain" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${current.name}.srt`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            disabled={!current.transcript}
          >
            SRT
          </Btn>
          {rendering ? (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                padding: "0 18px",
                height: 34,
                borderRadius: 999,
                background: tok.sunk,
                color: tok.ink2,
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: tok.accent,
                  animation: "titler-pulse 1.2s ease-in-out infinite",
                  color: tok.accent,
                }}
              />
              Rendering {renderProgress > 0 ? `${renderProgress}%` : "…"}
            </div>
          ) : (
            <Btn
              tok={tok}
              variant="primary"
              size="md"
              icon="render"
              onClick={onRender}
              disabled={!current.transcript}
            >
              Render MP4
            </Btn>
          )}
        </div>
      </div>
    </>
  );
};

const EmptyManuscript: React.FC<{
  tok: Tok;
  inbox: string[];
  onBatch: () => void;
  onRenderAll: () => void;
  canRenderAll: boolean;
}> = ({ tok, inbox, onBatch, onRenderAll, canRenderAll }) => (
  <div
    style={{
      flex: 1,
      display: "grid",
      placeItems: "center",
      padding: "10vh 0",
    }}
  >
    <div style={{ textAlign: "center", maxWidth: 460 }}>
      <div
        style={{
          fontFamily: FONTS.display,
          fontStyle: "italic",
          fontSize: "clamp(32px, 4vw, 48px)",
          letterSpacing: -1,
          lineHeight: 1.05,
          color: tok.ink,
        }}
      >
        Pick a project, or pull one from the inbox.
      </div>
      <div
        style={{
          marginTop: 14,
          color: tok.ink3,
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        Transcripts appear here as prose. Click words to jump the preview,
        double-click to edit. Style lives to the right.
      </div>
      <div
        style={{
          marginTop: 22,
          display: "flex",
          gap: 10,
          justifyContent: "center",
        }}
      >
        <Btn
          tok={tok}
          variant="outline"
          size="md"
          icon="batch"
          onClick={onBatch}
        >
          Batch ({inbox.length})
        </Btn>
        {canRenderAll && (
          <Btn
            tok={tok}
            variant="accent"
            size="md"
            icon="render"
            onClick={onRenderAll}
          >
            Render all ready
          </Btn>
        )}
      </div>
    </div>
  </div>
);

const StyleThumbnail: React.FC<{ styleId: CaptionStyle }> = ({ styleId }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background:
        "radial-gradient(ellipse at 50% 35%, oklch(0.48 0.06 50) 0%, oklch(0.28 0.04 50) 45%, oklch(0.14 0.02 50) 100%)",
      display: "flex",
      alignItems: "flex-end",
      justifyContent: "center",
      paddingBottom: styleId === "clean" ? "14%" : "18%",
    }}
  >
    {styleId === "bold" && (
      <div
        style={{
          display: "flex",
          gap: 3,
          fontFamily: `'Geist', sans-serif`,
          fontWeight: 900,
          fontSize: 10,
          letterSpacing: -0.3,
          textShadow: "0 1px 2px rgba(0,0,0,0.7)",
        }}
      >
        <span style={{ color: "#fff200" }}>BOLD</span>
      </div>
    )}
    {styleId === "clean" && (
      <div
        style={{
          padding: "3px 6px",
          background: "rgba(10,10,10,0.78)",
          borderRadius: 3,
          color: "#fff",
          fontSize: 8,
          fontFamily: `'Geist', sans-serif`,
          fontWeight: 500,
        }}
      >
        clean caption
      </div>
    )}
    {styleId === "focus" && (
      <div
        style={{
          fontFamily: `'Fraunces', serif`,
          fontStyle: "italic",
          fontWeight: 600,
          fontSize: 16,
          color: "#fff",
          textShadow: "0 2px 4px rgba(0,0,0,0.6)",
        }}
      >
        focus
      </div>
    )}
  </div>
);
