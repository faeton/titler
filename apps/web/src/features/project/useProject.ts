import type { Job, ProjectSettings, ProjectView, TranscriptRevision } from "@titler/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { activeJobs, api } from "../../api";
import { useInterval } from "../../lib/hooks";
import { Player } from "../../player/player";

type SettingsPatch = { [K in keyof ProjectSettings]?: Partial<ProjectSettings[K]> };

export interface ProjectCtx {
  id: string;
  view: ProjectView | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** Optimistic, debounced PATCH of settings. */
  patchSettings: (p: SettingsPatch) => void;
  /** Start a job and refresh. Returns the job or throws. */
  run: (start: () => Promise<Job>) => Promise<Job>;
  player: Player;
  /** Newest transcript revision known (polling or the editor's own saves). */
  rev: TranscriptRevision | null;
  noteRevision: (r: TranscriptRevision) => void;
  dock: HTMLElement | null;
  setDock: (el: HTMLElement | null) => void;
}

export const ProjectContext = createContext<ProjectCtx | null>(null);
export const useProjectCtx = () => {
  const c = useContext(ProjectContext);
  if (!c) throw new Error("no project context");
  return c;
};

const merge = (s: ProjectSettings, p: SettingsPatch): ProjectSettings => ({
  audio: { ...s.audio, ...p.audio },
  framing: { ...s.framing, ...p.framing },
  style: { ...s.style, ...p.style },
});

export const useProject = (id: string): ProjectCtx => {
  const [view, setView] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState<TranscriptRevision | null>(null);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const player = useMemo(() => new Player(), []);
  const pending = useRef<SettingsPatch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const noteRevision = useCallback((r: TranscriptRevision) => {
    setRev((cur) => (!cur || r.rev >= cur.rev ? r : cur));
  }, []);

  const accept = useCallback(
    (v: ProjectView) => {
      // Keep settings the user is still changing (debounced PATCH not sent yet).
      const p = pending.current;
      const hasPending = Object.keys(p).length > 0;
      setView(hasPending ? { ...v, project: { ...v.project, settings: merge(v.project.settings, p) } } : v);
      if (v.transcript) noteRevision(v.transcript);
      setError(null);
    },
    [noteRevision],
  );

  const refresh = useCallback(async () => {
    try {
      accept(await api.getProject(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, accept]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = activeJobs(view).length > 0;
  useInterval(() => !document.hidden && void refresh(), active ? 1500 : 12000);

  const patchSettings = useCallback(
    (p: SettingsPatch) => {
      const q = pending.current;
      pending.current = {
        audio: p.audio || q.audio ? { ...q.audio, ...p.audio } : undefined,
        framing: p.framing || q.framing ? { ...q.framing, ...p.framing } : undefined,
        style: p.style || q.style ? { ...q.style, ...p.style } : undefined,
      };
      for (const k of ["audio", "framing", "style"] as const) if (!pending.current[k]) delete pending.current[k];
      setView((v) => (v ? { ...v, project: { ...v.project, settings: merge(v.project.settings, p) } } : v));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const body = pending.current;
        pending.current = {};
        try {
          accept(await api.patchProject(id, { settings: body }));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }, 350);
    },
    [id, accept],
  );

  const run = useCallback(
    async (start: () => Promise<Job>) => {
      const job = await start();
      setView((v) => (v ? { ...v, jobs: [job, ...v.jobs.filter((j) => j.id !== job.id)] } : v));
      void refresh();
      return job;
    },
    [refresh],
  );

  return { id, view, error, refresh, patchSettings, run, player, rev, noteRevision, dock, setDock };
};
