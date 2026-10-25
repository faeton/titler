import type { ProjectSummary } from "@titler/core";
import { useCallback, useEffect, useState } from "react";
import { api, MOCK, STATE_LABEL, summaryState } from "../../api";
import { fmtDate, fmtTime } from "../../lib/format";
import { useInterval } from "../../lib/hooks";
import { UploadButton } from "../upload/UploadButton";
import { UploadList } from "../upload/UploadList";
import { useUploads } from "../upload/uploads";

const chipClass = { processing: "chip busy", ready: "chip warn", exported: "chip ok", new: "chip" } as const;

export const ProjectsScreen = () => {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploads = useUploads();
  const load = useCallback(async () => {
    try {
      setList(await api.listProjects());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, uploads.filter((u) => u.status === "done").length]);
  const busy = list?.some((p) => p.busy) ?? false;
  useInterval(() => !document.hidden && void load(), busy ? 3000 : 20000);

  return (
    <>
      <header className="topbar">
        <h1>Titler</h1>
        {MOCK ? <span className="chip warn">демо-данные</span> : null}
        <a className="btn ghost" href="#/access">
          Доступ
        </a>
      </header>
      <main className="scroll">
        <div className="projects">
          <div className="upload-cta">
            <UploadButton />
            <p className="hint">Видео с очков или из галереи. Если связь оборвётся, выберите тот же файл — загрузка продолжится.</p>
          </div>
          <UploadList />
          {error ? <div className="banner err">Сервер недоступен: {error}</div> : null}
          {list === null && !error ? <div className="empty">Загружаю…</div> : null}
          {list?.length === 0 ? <div className="empty">Пока нет роликов.</div> : null}
          <div className="plist">
            {list?.map((s) => {
              const st = summaryState(s);
              return (
                <a key={s.project.id} className="pcard" href={`#/p/${encodeURIComponent(s.project.id)}/${s.hasTranscript ? "text" : "audio"}`}>
                  <span className="thumb" style={s.thumbnailUrl ? { backgroundImage: `url("${s.thumbnailUrl}")` } : undefined} />
                  <div>
                    <span className="name">{s.project.name}</span>
                    <span className="meta">
                      {fmtDate(s.project.createdAt)}
                      {s.project.probe ? ` · ${fmtTime(s.project.probe.durationMs)}` : ""}
                    </span>
                    <span>
                      <span className={chipClass[st]}>
                        {st === "processing" ? <i className="spin" /> : null}
                        {STATE_LABEL[st]}
                      </span>
                    </span>
                  </div>
                  <span aria-hidden style={{ color: "var(--muted)", fontSize: 22 }}>
                    ›
                  </span>
                </a>
              );
            })}
          </div>
        </div>
      </main>
    </>
  );
};
