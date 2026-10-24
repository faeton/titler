import { allWords } from "@titler/core";
import { useEffect, useMemo, useState } from "react";
import { api, isActive, latestJob, renderOutputs, type OutputKind, type RenderOutput } from "../../api";
import { fmtBytes, fmtDate } from "../../lib/format";
import { useProjectCtx } from "../project/useProject";

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

export const ExportTab = () => {
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
  const outputs = useMemo(() => renderOutputs(view), [view]);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const captionText = useMemo(
    () =>
      rev
        ? rev.doc.paragraphs
            .map((p) => p.words.filter((w) => !w.hidden).map((w) => w.text).join(" "))
            .filter(Boolean)
            .join("\n\n")
        : "",
    [rev],
  );
  const hasWords = rev ? allWords(rev.doc).length > 0 : false;

  const start = async () => {
    setErr(null);
    try {
      await run(() => api.startRender(id, { outputs: sel }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(captionText);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = captionText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="scroll">
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
          <button className="btn primary big" disabled={!sel.length || !view?.urls.proxy} onClick={() => void start()}>
            Экспортировать
          </button>
        )}
        {job?.status === "error" ? <div className="banner err">Экспорт не удался: {job.error}</div> : null}
        {err ? <div className="banner err">{err}</div> : null}
      </div>

      <div className="section">
        <h2>Готовые файлы</h2>
        {outputs.length ? (
          <div className="outs">
            {outputs.map((o) => (
              <OutputRow key={o.url + o.createdAt} o={o} currentRev={rev?.rev ?? 0} />
            ))}
          </div>
        ) : (
          <p className="hint">Пока ничего не экспортировано.</p>
        )}
      </div>

      <div className="section">
        <h2>Подпись к публикации</h2>
        <button className="btn" disabled={!captionText} onClick={() => void copy()}>
          {copied ? "Скопировано ✓" : "Скопировать текст"}
        </button>
        <p className="hint">Текст без слов, убранных из субтитров.</p>
      </div>
    </div>
  );
};

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
