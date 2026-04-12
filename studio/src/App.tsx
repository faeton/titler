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
  submitBatchImport,
  submitBatchRender,
  clearJobs,
  listPresetsApi,
  createPreset,
  deletePresetApi,
  type Project,
  type CropMode,
  type Job,
  type Preset,
} from "./api";
import { TranscriptEditor } from "./components/TranscriptEditor";

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

// --- main app ---
type LogEntry = { t: number; text: string };

export const App = () => {
  const [inbox, setInbox] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<Project | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>("bold");
  const [rendering, setRendering] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [watermark, setWatermark] = useState(true);
  const [presets, setPresets] = useState<Preset[]>([]);
  const playerRef = useRef<PlayerRef>(null);

  // Jobs
  const [jobs, setJobs] = useState<Job[]>([]);

  // Batch selection
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [selectedInbox, setSelectedInbox] = useState<Set<string>>(new Set());

  const refresh = async () => {
    const [i, p, pr] = await Promise.all([
      listInbox(),
      listProjects({ archived: showArchived }),
      listPresetsApi().catch(() => [] as Preset[]),
    ]);
    setInbox(i);
    setProjects(p);
    setPresets(pr);
  };

  useEffect(() => {
    refresh().catch((e) => pushLog(`error: ${e.message}`));
  }, [showArchived]);

  // Subscribe to live server events (inbox watcher notifications)
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "new_file") {
          pushLog(`inbox: new file detected`);
        } else if (data.type === "project_created") {
          pushLog(`inbox: auto-imported, ingesting...`);
          refresh();
        }
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, []);

  // Poll jobs while any are active
  const hasActiveJobs = jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );
  useEffect(() => {
    if (!hasActiveJobs) return;
    const interval = setInterval(async () => {
      try {
        const { jobs: fresh } = await listJobs();
        setJobs(fresh);
        // Also refresh projects list so status updates show
        const [i, p] = await Promise.all([
          listInbox(),
          listProjects({ archived: showArchived }),
        ]);
        setInbox(i);
        setProjects(p);
      } catch {
        /* ignore poll errors */
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [hasActiveJobs, showArchived]);

  // Track playback time from the Remotion Player
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const handler = () => {
      const frame = player.getCurrentFrame();
      setCurrentTime(frame / VIDEO_FPS);
    };
    player.addEventListener("frameupdate", handler as any);
    return () => player.removeEventListener("frameupdate", handler as any);
  }, [current]);

  const pushLog = (text: string) =>
    setLogs((prev) => [...prev.slice(-200), { t: Date.now(), text }]);

  // --- single project actions ---

  const onPickInbox = async (file: string) => {
    setBusy(true);
    try {
      pushLog(`creating project for ${file}`);
      const project = await createProject(file);
      await refresh();
      setCurrent(project);
      pushLog(`project ${project.id} created; ingesting...`);
      await runStream(`/projects/${project.id}/ingest`, (ev) => {
        pushLog(`  ingest: ${JSON.stringify(ev)}`);
      });
      const ingested = await getProject(project.id);
      setCurrent(ingested);
      pushLog(`ingest done; transcribing...`);
      await runStream(`/projects/${project.id}/transcribe`, (ev) => {
        const s = JSON.stringify(ev);
        pushLog(`  tx: ${s.length > 120 ? s.slice(0, 120) + "\u2026" : s}`);
      });
      const final = await getProject(project.id);
      setCurrent(final);
      await refresh();
      pushLog(
        `transcribe done (${final.transcript?.words.length ?? 0} words)`,
      );
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
    }, 2000);
  }, []);

  const onPause = useCallback(() => {
    try {
      playerRef.current?.pause();
    } catch {
      /* unmounted */
    }
  }, []);

  const onRender = useCallback(async () => {
    if (!current) return;
    setRendering(true);
    pushLog(`rendering ${current.name} with style=${captionStyle}...`);
    try {
      await runStream(
        `/projects/${current.id}/render?style=${captionStyle}&watermark=${watermark}`,
        (ev) => {
          const s = JSON.stringify(ev);
          pushLog(`  render: ${s.length > 120 ? s.slice(0, 120) + "\u2026" : s}`);
        },
      );
      pushLog(`render complete!`);
    } catch (e) {
      pushLog(`render error: ${(e as Error).message}`);
    } finally {
      setRendering(false);
    }
  }, [current, captionStyle]);

  const onEditWord = useCallback(
    async (index: number, newText: string) => {
      if (!current?.transcript) return;
      const updated = { ...current };
      const words = [...current.transcript.words];
      words[index] = { ...words[index], text: newText };
      updated.transcript = { ...current.transcript, words };
      setCurrent(updated);
      try {
        await fetch(`/api/projects/${current.id}/transcript`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ words }),
        });
      } catch (e) {
        pushLog(`save error: ${(e as Error).message}`);
      }
    },
    [current],
  );

  // --- crop mode ---

  const onChangeCropMode = useCallback(
    async (mode: CropMode) => {
      if (!current) return;
      setBusy(true);
      pushLog(`changing crop mode to ${mode}...`);
      try {
        if (mode === "face_track" && !current.faceTrack) {
          pushLog(`running face tracking first...`);
          await runStream(`/projects/${current.id}/face-track`, (ev) => {
            pushLog(`  face: ${JSON.stringify(ev)}`);
          });
        }
        pushLog(`re-ingesting with crop=${mode}...`);
        await runStream(
          `/projects/${current.id}/reingest`,
          (ev) => {
            pushLog(`  reingest: ${JSON.stringify(ev)}`);
          },
          { body: { cropMode: mode } },
        );
        const updated = await getProject(current.id);
        setCurrent(updated);
        await refresh();
        pushLog(`crop mode changed to ${mode}`);
      } catch (e) {
        pushLog(`crop error: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [current],
  );

  // --- rename ---

  const onRenameProject = useCallback(
    async () => {
      if (!current) return;
      const name = prompt("Rename project:", current.name);
      if (!name || name === current.name) return;
      try {
        await renameProject(current.id, name);
        setCurrent({ ...current, name });
        await refresh();
      } catch (e) {
        pushLog(`rename error: ${(e as Error).message}`);
      }
    },
    [current],
  );

  // --- delete / archive ---

  const onDeleteProject = useCallback(
    async (id: string) => {
      try {
        await deleteProject(id);
        if (current?.id === id) setCurrent(null);
        await refresh();
        pushLog(`deleted project ${id}`);
      } catch (e) {
        pushLog(`delete error: ${(e as Error).message}`);
      }
    },
    [current],
  );

  const onArchiveProject = useCallback(
    async (id: string) => {
      try {
        await archiveProject(id);
        if (current?.id === id) setCurrent(null);
        await refresh();
        pushLog(`toggled archive for ${id}`);
      } catch (e) {
        pushLog(`archive error: ${(e as Error).message}`);
      }
    },
    [current],
  );

  // --- batch actions ---

  const toggleProjectSelection = (id: string) => {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleInboxSelection = (file: string) => {
    setSelectedInbox((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  const selectAllInbox = () => {
    if (selectedInbox.size === inbox.length) setSelectedInbox(new Set());
    else setSelectedInbox(new Set(inbox));
  };

  const selectAllProjects = () => {
    if (selectedProjects.size === projects.length)
      setSelectedProjects(new Set());
    else setSelectedProjects(new Set(projects.map((p) => p.id)));
  };

  const onBatchImport = async () => {
    if (selectedInbox.size === 0) return;
    const files = [...selectedInbox];
    setSelectedInbox(new Set());
    try {
      const { results } = await submitBatchImport(files);
      const ok = results.filter((r) => r.projectId).length;
      const fail = results.filter((r) => r.error).length;
      pushLog(
        `queued ${ok} imports${fail ? ` (${fail} failed)` : ""} — processing server-side`,
      );
      // Kick off job polling
      const { jobs: fresh } = await listJobs();
      setJobs(fresh);
      await refresh();
    } catch (e) {
      pushLog(`batch import error: ${(e as Error).message}`);
    }
  };

  const onBatchRender = async () => {
    if (selectedProjects.size === 0) return;
    const ids = [...selectedProjects];
    setSelectedProjects(new Set());
    try {
      const { jobs: newJobs } = await submitBatchRender(ids, captionStyle);
      pushLog(
        `queued ${newJobs.length} renders (${captionStyle}) — processing server-side`,
      );
      const { jobs: fresh } = await listJobs();
      setJobs(fresh);
    } catch (e) {
      pushLog(`batch render error: ${(e as Error).message}`);
    }
  };

  const onBatchDelete = async () => {
    if (selectedProjects.size === 0) return;
    if (!confirm(`Delete ${selectedProjects.size} projects?`)) return;
    const ids = [...selectedProjects];
    setSelectedProjects(new Set());
    for (const id of ids) {
      try {
        await deleteProject(id);
      } catch (e) {
        pushLog(`  delete error: ${(e as Error).message}`);
      }
    }
    if (current && ids.includes(current.id)) setCurrent(null);
    await refresh();
    pushLog(`deleted ${ids.length} projects`);
  };

  const onBatchArchive = async () => {
    if (selectedProjects.size === 0) return;
    const ids = [...selectedProjects];
    setSelectedProjects(new Set());
    for (const id of ids) {
      try {
        await archiveProject(id);
      } catch (e) {
        pushLog(`  archive error: ${(e as Error).message}`);
      }
    }
    if (current && ids.includes(current.id)) setCurrent(null);
    await refresh();
    pushLog(`archived ${ids.length} projects`);
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
    };
  }, [current, captionStyle]);

  const durationInFrames = Math.max(
    1,
    Math.round(playerProps.durationInSeconds * VIDEO_FPS),
  );

  const hasInboxSelection = selectedInbox.size > 0;
  const hasProjectSelection = selectedProjects.size > 0;

  return (
    <div className="app">
      <aside className="sidebar">
        {/* Inbox section */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 8px",
          }}
        >
          <h2 style={{ flex: 1 }}>inbox (in/)</h2>
          {inbox.length > 0 && (
            <button
              onClick={selectAllInbox}
              style={{ fontSize: 10, padding: "2px 6px" }}
            >
              {selectedInbox.size === inbox.length ? "none" : "all"}
            </button>
          )}
        </div>
        {inbox.length === 0 && <div className="log">empty</div>}
        <ul>
          {inbox.map((f) => {
            const name = f.split("/").pop() ?? f;
            const selected = selectedInbox.has(f);
            return (
              <li
                key={f}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: selected ? "rgba(250,204,21,0.1)" : undefined,
                }}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleInboxSelection(f)}
                  style={{ accentColor: "#facc15" }}
                />
                <span
                  onClick={() => !busy && onPickInbox(f)}
                  style={{ flex: 1, cursor: "pointer" }}
                >
                  {name}
                </span>
              </li>
            );
          })}
        </ul>
        {hasInboxSelection && (
          <div style={{ padding: "4px 8px" }}>
            <button
              onClick={onBatchImport}
              disabled={busy}
              style={{
                width: "100%",
                background: "#facc15",
                color: "#000",
                fontWeight: 600,
                padding: "6px",
                fontSize: 12,
              }}
            >
              import {selectedInbox.size} selected
            </button>
          </div>
        )}

        {/* Projects section */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 8px",
            marginTop: 8,
          }}
        >
          <h2 style={{ flex: 1 }}>projects</h2>
          <label
            style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 3 }}
          >
            <input
              type="checkbox"
              checked={showArchived}
              onChange={() => setShowArchived(!showArchived)}
              style={{ accentColor: "#888" }}
            />
            archived
          </label>
          {projects.length > 0 && (
            <button
              onClick={selectAllProjects}
              style={{ fontSize: 10, padding: "2px 6px" }}
            >
              {selectedProjects.size === projects.length ? "none" : "all"}
            </button>
          )}
        </div>
        {projects.length === 0 && <div className="log">none yet</div>}
        <ul>
          {projects.map((p) => {
            const hasExport = (p.rendered?.length ?? 0) > 0;
            const isEdited = p.edited;
            const device = p.source?.original.device ?? "";
            const recDate = p.source?.original.createdAt;
            const isTelegram = p.source?.aspectStrategy === "telegram_circle";
            const isGlasses = /ray.ban|glasses|smart glass/i.test(device);
            const dur = p.source?.original.duration ?? 0;
            const durStr =
              dur > 0
                ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, "0")}`
                : "";
            const selected = selectedProjects.has(p.id);

            return (
              <li
                key={p.id}
                className={current?.id === p.id ? "active" : ""}
                style={{
                  padding: "8px 8px",
                  display: "flex",
                  gap: 6,
                  background: selected
                    ? "rgba(250,204,21,0.1)"
                    : p.archived
                      ? "rgba(100,100,100,0.1)"
                      : undefined,
                  opacity: p.archived ? 0.5 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(e) => {
                    e.stopPropagation();
                    toggleProjectSelection(p.id);
                  }}
                  style={{ accentColor: "#facc15", marginTop: 2 }}
                />
                <div
                  style={{ flex: 1, cursor: "pointer" }}
                  onClick={() => onPickProject(p.id)}
                >
                  {/* Row 1: date + source icon + status badges */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 13,
                    }}
                  >
                    {isTelegram && (
                      <span title="Telegram" style={{ fontSize: 15 }}>
                        {"\u2709"}
                      </span>
                    )}
                    {isGlasses && (
                      <span title={device} style={{ fontSize: 15 }}>
                        {"\uD83D\uDC53"}
                      </span>
                    )}
                    {!isTelegram && !isGlasses && device && (
                      <span title={device} style={{ fontSize: 15 }}>
                        {"\uD83D\uDCF1"}
                      </span>
                    )}

                    <span style={{ flex: 1 }}>
                      {recDate
                        ? new Date(recDate).toLocaleDateString("ru-RU", {
                            day: "2-digit",
                            month: "2-digit",
                            year: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : p.name.slice(0, 20)}
                    </span>

                    {durStr && (
                      <span style={{ fontSize: 10, color: "#666" }}>
                        {durStr}
                      </span>
                    )}

                    {isEdited && (
                      <span
                        title="edited"
                        style={{
                          fontSize: 9,
                          color: "#facc15",
                          fontWeight: 700,
                        }}
                      >
                        E
                      </span>
                    )}
                    {hasExport && (
                      <span
                        title={`rendered: ${p.rendered!.join(", ")}`}
                        style={{
                          fontSize: 9,
                          color: "#4ade80",
                          fontWeight: 700,
                        }}
                      >
                        R
                      </span>
                    )}
                    {p.archived && (
                      <span
                        title="archived"
                        style={{
                          fontSize: 9,
                          color: "#888",
                          fontWeight: 700,
                        }}
                      >
                        A
                      </span>
                    )}
                  </div>

                  {/* Row 2: filename small */}
                  <div
                    style={{
                      fontSize: 10,
                      color: "#555",
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.name}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        {/* Batch action bar */}
        {hasProjectSelection && (
          <div
            style={{
              padding: "6px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ fontSize: 11, color: "#888" }}>
              {selectedProjects.size} selected
            </div>
            <button
              onClick={onBatchRender}
              disabled={busy}
              style={{
                width: "100%",
                background: "#facc15",
                color: "#000",
                fontWeight: 600,
                padding: "5px",
                fontSize: 11,
              }}
            >
              render all ({captionStyle})
            </button>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                onClick={onBatchArchive}
                disabled={busy}
                style={{ flex: 1, fontSize: 11, padding: "4px" }}
              >
                archive
              </button>
              <button
                onClick={onBatchDelete}
                disabled={busy}
                style={{
                  flex: 1,
                  fontSize: 11,
                  padding: "4px",
                  color: "#ef4444",
                }}
              >
                delete
              </button>
            </div>
          </div>
        )}
        {/* Job queue status */}
        {jobs.length > 0 && (
          <div style={{ padding: "8px", borderTop: "1px solid #2c2c33" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 4,
              }}
            >
              <h2
                style={{ flex: 1, fontSize: 11, color: "#888", margin: 0 }}
              >
                jobs
              </h2>
              <button
                onClick={async () => {
                  await clearJobs();
                  const { jobs: fresh } = await listJobs();
                  setJobs(fresh);
                }}
                style={{ fontSize: 9, padding: "2px 5px", color: "#888" }}
              >
                clear done
              </button>
            </div>
            {jobs.slice(0, 10).map((j) => {
              const proj = projects.find((p) => p.id === j.projectId);
              const name = proj?.name ?? j.projectId;
              const short = name.length > 20 ? name.slice(0, 18) + "\u2026" : name;
              return (
                <div
                  key={j.id}
                  style={{
                    fontSize: 10,
                    padding: "2px 0",
                    color:
                      j.status === "error"
                        ? "#ef4444"
                        : j.status === "done"
                          ? "#4ade80"
                          : j.status === "running"
                            ? "#facc15"
                            : "#888",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>
                    {j.status === "running"
                      ? "\u25B6"
                      : j.status === "queued"
                        ? "\u23F3"
                        : j.status === "done"
                          ? "\u2713"
                          : "\u2717"}
                  </span>{" "}
                  {short}{" "}
                  <span style={{ color: "#666" }}>
                    {j.progress ?? j.status}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </aside>

      <section className="main">
        <div className="toolbar">
          <span className="title">
            {current ? current.name : "titler studio"}
          </span>

          {current?.transcript && (
            <>
              <select
                value={captionStyle}
                onChange={(e) =>
                  setCaptionStyle(e.target.value as CaptionStyle)
                }
                style={{
                  font: "inherit",
                  fontSize: 13,
                  background: "#1d1d22",
                  color: "#e6e6e6",
                  border: "1px solid #2c2c33",
                  borderRadius: 6,
                  padding: "5px 10px",
                }}
              >
                <option value="bold">Bold</option>
                <option value="clean">Clean</option>
                <option value="focus">Focus</option>
              </select>

              {/* Preset selector */}
              {presets.length > 0 && (
                <select
                  onChange={(e) => {
                    const p = presets.find((pr) => pr.id === e.target.value);
                    if (p) {
                      setCaptionStyle(p.style as any);
                      setWatermark(p.watermark);
                    }
                  }}
                  defaultValue=""
                  style={{
                    font: "inherit",
                    fontSize: 11,
                    background: "#1d1d22",
                    color: "#aaa",
                    border: "1px solid #2c2c33",
                    borderRadius: 6,
                    padding: "4px 8px",
                  }}
                >
                  <option value="" disabled>
                    presets
                  </option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={async () => {
                  const name = prompt("Preset name:");
                  if (!name) return;
                  await createPreset({
                    name,
                    style: captionStyle,
                    watermark,
                    cropMode: "center",
                  });
                  await refresh();
                  pushLog(`saved preset "${name}"`);
                }}
                style={{ fontSize: 11, padding: "4px 8px", color: "#aaa" }}
              >
                save preset
              </button>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11,
                  color: "#888",
                }}
              >
                <input
                  type="checkbox"
                  checked={watermark}
                  onChange={() => setWatermark(!watermark)}
                  style={{ accentColor: "#facc15" }}
                />
                watermark
              </label>

              <button
                onClick={onRender}
                disabled={rendering || busy}
                style={{
                  background: rendering ? "#333" : "#facc15",
                  color: "#000",
                  fontWeight: 600,
                }}
              >
                {rendering ? "rendering..." : "render MP4"}
              </button>
            </>
          )}

          {/* Crop mode + project actions */}
          {current?.source && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginLeft: 8,
              }}
            >
              {/* Only show crop toggle for croppable strategies */}
              {current.source.aspectStrategy === "crop" && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 12,
                    color: "#aaa",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={current.cropMode === "face_track"}
                    disabled={busy}
                    onChange={() =>
                      onChangeCropMode(
                        current.cropMode === "face_track"
                          ? "center"
                          : "face_track",
                      )
                    }
                    style={{ accentColor: "#facc15" }}
                  />
                  face track
                </label>
              )}

              <button
                onClick={onRenameProject}
                disabled={busy}
                style={{ fontSize: 11, padding: "4px 8px", color: "#aaa" }}
              >
                rename
              </button>
              <button
                onClick={() => onArchiveProject(current.id)}
                disabled={busy}
                style={{ fontSize: 11, padding: "4px 8px", color: "#888" }}
              >
                {current.archived ? "unarchive" : "archive"}
              </button>
              <button
                onClick={() => {
                  if (confirm(`Delete "${current.name}"?`))
                    onDeleteProject(current.id);
                }}
                disabled={busy}
                style={{ fontSize: 11, padding: "4px 8px", color: "#ef4444" }}
              >
                delete
              </button>
            </div>
          )}

          <button
            onClick={() => refresh()}
            disabled={busy}
            style={{ marginLeft: "auto" }}
          >
            refresh
          </button>
        </div>

        <div className="stage">
          <div className="player-wrap">
            {current?.source ? (
              <div className="player">
                <ErrorBoundary
                  fallback={
                    <div style={{ color: "red", padding: 16 }}>
                      Player crashed — check browser console
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
                    controls
                    acknowledgeRemotionLicense
                  />
                </ErrorBoundary>
              </div>
            ) : (
              <div className="empty">
                {current
                  ? "ingesting..."
                  : "select a project or pick from inbox"}
              </div>
            )}
          </div>

          <div className="side-panel">
            {current?.transcript && (
              <>
                <h2 style={{ fontSize: 11, color: "#888" }}>
                  transcript · click word to hear · double-click to edit
                </h2>
                <TranscriptEditor
                  transcript={current.transcript}
                  currentTime={currentTime}
                  onSeek={onSeek}
                  onPause={onPause}
                  onEdit={onEditWord}
                />
              </>
            )}

            {logs.length > 0 && (
              <>
                <h2 style={{ fontSize: 11, color: "#888", marginTop: 16 }}>
                  log
                </h2>
                <div className="log">
                  {logs.slice(-20).map((l) => (
                    <div key={l.t + l.text}>{l.text}</div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
