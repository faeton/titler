import {
  compilePartCues,
  cutCandidates,
  resolveCuts,
  seriesBadge,
  seriesParts,
  seriesWords,
  shiftCues,
  type Cue,
  type CutCandidate,
  type ProjectView,
  type SeriesWord,
  type SpeechRegion,
  type TranscriptDoc,
} from "@titler/core";
import { useEffect, useMemo, useState } from "react";

// The export screen's view of the series plan. Same core functions as the
// server's render (resolveCuts / compilePartCues / seriesBadge), so what the
// timeline and the preview show is what gets rendered.

export interface PreviewBadge {
  /** Source ms. */
  startMs: number;
  endMs: number;
  text: string;
}

export interface SeriesPlanView {
  durationMs: number;
  maxPartMs: number | null;
  cuts: number[];
  manual: boolean;
  parts: { startMs: number; endMs: number }[];
  words: SeriesWord[];
  candidates: CutCandidate[];
  /** Per-part cues shifted back to source time (preview on the full proxy). */
  cues: Cue[];
  badges: PreviewBadge[];
}

const vadCache = new Map<string, Promise<SpeechRegion[]>>();

const loadVad = (url: string): Promise<SpeechRegion[]> => {
  let p = vadCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.json() : { regions: [] }))
      .then((j: { regions?: SpeechRegion[] }) => j.regions ?? [])
      .catch(() => []);
    vadCache.set(url, p);
  }
  return p;
};

export const useVad = (url: string | null): SpeechRegion[] => {
  const [vad, setVad] = useState<SpeechRegion[]>([]);
  useEffect(() => {
    if (!url) return;
    let live = true;
    void loadVad(url).then((r) => live && setVad(r));
    return () => {
      live = false;
    };
  }, [url]);
  return vad;
};

export const useSeriesPlan = (view: ProjectView | null, doc: TranscriptDoc | null): SeriesPlanView | null => {
  const vad = useVad(view?.urls.vad ?? null);
  const settings = view?.project.settings;
  const durationMs = view?.project.probe?.durationMs ?? 0;
  const words = useMemo(() => seriesWords(doc, durationMs), [doc, durationMs]);
  return useMemo(() => {
    if (!settings || !durationMs) return null;
    const { series, style } = settings;
    const plan = resolveCuts(series, words, vad, durationMs);
    const parts = seriesParts(plan.cuts, durationMs, series.overlapMs);
    const multi = parts.length > 1;
    const cues = !doc
      ? []
      : multi
        ? parts.flatMap((p) => shiftCues(compilePartCues(doc, style, durationMs, p), p.startMs))
        : [];
    const badges: PreviewBadge[] = [];
    parts.forEach((p, i) => {
      const b = multi ? seriesBadge(series.numbering, i, parts.length, p.endMs - p.startMs) : null;
      if (b) badges.push({ startMs: p.startMs + b.start, endMs: p.startMs + b.end, text: b.text });
    });
    return {
      durationMs,
      maxPartMs: plan.maxPartMs,
      cuts: plan.cuts,
      manual: plan.manual,
      parts,
      words,
      candidates: cutCandidates(words, vad, durationMs),
      cues,
      badges,
    };
  }, [settings, durationMs, words, vad, doc]);
};
