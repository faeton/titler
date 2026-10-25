import { allWords, effectiveTimes, SERIES_PRESETS, type SeriesDestination, type TranscriptDoc } from "@titler/core";
import { useEffect, useMemo, useState } from "react";
import { api, groupOutputs, isActive, latestJob, renderOutputs, type OutputKind, type RenderOutput } from "../../api";
import { fmtBytes, fmtDate } from "../../lib/format";
import { useProjectCtx } from "../project/useProject";
import type { SeriesPlanView } from "./series";
import { CoverPanel } from "./CoverPanel";
import { SeriesPanel } from "./SeriesPanel";

const OUTPUTS: [OutputKind, string][] = [
  ["captioned", "Видео с субтитрами"],
  ["clean", "Видео без субтитров"],
  ["srt", "Субтитры SRT"],
  ["vtt", "Субтитры VTT"],
];
const OUT_LABEL = Object.fromEntries(OUTPUTS) as Record<string, string>;

const canShareFiles = (() => {
  try {
    return !!navigator.canShare?.({ files: [new File([""], "x.mp4", { type: "video/mp4" })] });
  } catch {
    return false;
  }
})();

const SHARE_KEY = "titler.export.outputs";

/** Caption text of the words whose midpoint is in [t0, t1) (whole clip when no range). */
const captionOf = (doc: TranscriptDoc, durationMs: number, range?: { startMs: number; endMs: number }): string => {
  const words = allWords(doc);
  const times = effectiveTimes(words, durationMs);
  const keep = new Set(
    words.filter((w, i) => !w.hidden && (!range || ((times[i]!.start + times[i]!.end) / 2 >= range.startMs && (times[i]!.start + times[i]!.end) / 2 < range.endMs))).map((w) => w.id),
  );
  return doc.paragraphs
    .map((p) => p.words.filter((w) => keep.has(w.id)).map((w) => w.text).join(" "))
    .filter(Boolean)
    .join("\n\n");
};

export const ExportTab = ({ plan }: { plan: SeriesPlanView | null }) => {
  const { view, run, id, rev } = useProjectCtx();
  const [sel, setSel] = useState<OutputKind[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(SHARE_KEY) ?? "") as OutputKind[];
    } catch {
      return ["captioned", "srt"];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SHARE_KEY, JSON.stringify(sel));
    } catch {
      /* ignore */
    }
  }, [sel]);
  const job = latestJob(view, "render");
  const busy = !!job && isActive(job);
  const groups = useMemo(() => groupOutputs(renderOutputs(view)), [view]);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const durationMs = view?.project.probe?.durationMs ?? 0;
  const parts = plan && plan.parts.length > 1 ? plan.parts : null;
  const over = !!parts && plan!.maxPartMs !== null && parts.some((p) => p.endMs - p.startMs > plan!.maxPartMs!);

  // One caption per part, «(1/3)» appended, as creators label series.
  const captions = useMemo(() => {
    if (!rev) return [];
    if (!parts) return [captionOf(rev.doc, durationMs)];
    return parts.map((p, i) => `${captionOf(rev.doc, durationMs, p)} (${i + 1}/${parts.length})`.trim());
  }, [rev, parts, durationMs]);
  const hasWords = rev ? allWords(rev.doc).length > 0 : false;

  const start = async () => {
    setErr(null);
    try {
      await run(() => api.startRender(id, { outputs: sel, series: true }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async (k: number) => {
    const text = captions[k] ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(k);
    setTimeout(() => setCopied(null), 1800);
  };

  return (
    <div className="scroll">
      {plan ? <SeriesPanel plan={plan} /> : null}
      <div className="section">
        <h2>Что сделать</h2>
        {OUTPUTS.map(([k, l]) => (
          <label key={k} className="switch">
            <input
              type="checkbox"
              checked={sel.includes(k)}
              onChange={(e) => setSel(e.target.checked ? [...sel, k] : sel.filter((x) => x !== k))}
            />
            {l}
          </label>
        ))}
        {!hasWords && (sel.includes("captioned") || sel.includes("srt") || sel.includes("vtt")) ? (
          <p className="hint">Текста пока нет — субтитры будут пустыми.</p>
        ) : null}
        {busy ? (
          <div className="card" style={{ display: "grid", gap: 8 }}>
            <div className="row">
              <span className="grow">
                {job.status === "queued" ? "В очереди…" : `Экспорт ${Math.round((job.progress ?? 0) * 100)}%`}
                {job.message ? ` · ${job.message}` : ""}
              </span>
              <button className="btn ghost" onClick={() => void api.cancelJob(job.id).then(() => run(async () => job))}>
                Отменить
              </button>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} />
            </div>
          </div>
        ) : (
          <button className="btn primary big" disabled={!sel.length || !view?.urls.proxy || over} onClick={() => void start()}>
            {parts ? `Экспортировать ${parts.length} ${parts.length < 5 ? "части" : "частей"}` : "Экспортировать"}
          </button>
        )}
        {over ? <p className="hint">Часть длиннее лимита площадки — сдвиньте разрезы или нажмите «Авто».</p> : null}
        {job?.status === "error" ? <div className="banner err">Экспорт не удался: {job.error}</div> : null}
        {err ? <div className="banner err">{err}</div> : null}
      </div>

      {view?.project.probe ? <CoverPanel plan={plan} /> : null}

      <div className="section">
        <h2>Готовые файлы</h2>
        {groups.length ? (
          <div className="outs">
            {groups.map((g) => (
              <div className="out-group" key={g.key}>
                {g.part ? (
                  <h3>
                    {SERIES_PRESETS[g.part.destination as SeriesDestination]?.label ?? g.part.destination} · часть {g.part.index + 1} из {g.part.total}
                    <span className="hint"> · {fmtSpan(g.part.startMs, g.part.endMs)}</span>
                  </h3>
                ) : groups.some((x) => x.part) ? (
                  <h3>Целиком</h3>
                ) : null}
                {g.outputs.map((o) => (
                  <OutputRow key={o.url + o.createdAt} o={o} currentRev={rev?.rev ?? 0} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <p className="hint">Пока ничего не экспортировано.</p>
        )}
      </div>

      <div className="section">
        <h2>Подпись к публикации</h2>
        <div className="row">
          {captions.map((c, k) => (
            <button key={k} className="btn" disabled={!c} onClick={() => void copy(k)}>
              {copied === k ? "Скопировано ✓" : captions.length > 1 ? `Часть ${k + 1}` : "Скопировать текст"}
            </button>
          ))}
        </div>
        <p className="hint">Текст без слов, убранных из субтитров{captions.length > 1 ? "; у каждой части свой, с «(1/3)» в конце" : ""}.</p>
      </div>
    </div>
  );
};

const fmtSpan = (a: number, b: number) => `${(a / 1000).toFixed(1)}–${(b / 1000).toFixed(1)} с`;

const OutputRow = ({ o, currentRev }: { o: RenderOutput; currentRev: number }) => {
  const [file, setFile] = useState<File | "loading" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const outdated = o.transcriptRev !== null && o.transcriptRev < currentRev;

  // Web Share needs a File in hand *and* a fresh tap: fetch first, then "Отправить".
  const share = async () => {
    setErr(null);
    if (file instanceof File) {
      try {
        await navigator.share({ files: [file], title: o.fileName });
      } catch (e) {
        if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      }
      return;
    }
    setFile("loading");
    try {
      const res = await fetch(o.url);
      const blob = await res.blob();
      const f = new File([blob], o.fileName, { type: blob.type || (o.kind === "srt" || o.kind === "vtt" ? "text/plain" : "video/mp4") });
      if (!navigator.canShare?.({ files: [f] })) throw new Error("Этот файл нельзя передать в приложение — скачайте его");
      setFile(f);
    } catch (e) {
      setFile(null);
      setErr((e as Error).message);
    }
  };

  return (
    <div className="out">
      <div style={{ minWidth: 0 }}>
        <div className="t">{OUT_LABEL[o.kind] ?? o.fileName}</div>
        <div className="s">
          {fmtDate(o.createdAt)}
          {o.bytes ? ` · ${fmtBytes(o.bytes)}` : ""}
          {outdated ? " · текст менялся после экспорта" : ""}
        </div>
        {err ? <div className="s" style={{ color: "var(--danger)" }}>{err}</div> : null}
      </div>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <a className="btn" href={o.url} download={o.fileName}>
          Скачать
        </a>
        {canShareFiles ? (
          <button className={file instanceof File ? "btn primary" : "btn"} disabled={file === "loading"} onClick={() => void share()}>
            {file === "loading" ? "Готовлю…" : file instanceof File ? "Отправить" : "Поделиться"}
          </button>
        ) : null}
      </div>
    </div>
  );
};
