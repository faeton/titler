import { fmtBytes } from "../../lib/format";
import { go } from "../../lib/hooks";
import { dismiss, forget, unfinished, useUploads } from "./uploads";

export const UploadList = () => {
  const items = useUploads();
  const live = new Set(items.map((i) => i.key));
  const stale = unfinished().filter((u) => !live.has(u.key));
  if (!items.length && !stale.length) return null;
  return (
    <div className="plist" aria-label="Загрузки">
      {items.map((u) => (
        <div key={u.key} className="card" style={{ display: "grid", gap: 8 }}>
          <div className="row">
            <b className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {u.name}
            </b>
            {u.status === "done" && u.projectId ? (
              <button className="btn" onClick={() => go("p", u.projectId!, "audio")}>
                Открыть
              </button>
            ) : null}
            {u.status === "done" || u.status === "error" ? (
              <button className="btn ghost icon" aria-label="Скрыть" onClick={() => dismiss(u.key)}>
                ×
              </button>
            ) : null}
          </div>
          {u.status !== "done" ? (
            <div className="bar" role="progressbar" aria-valuenow={Math.round((u.received / u.size) * 100)}>
              <i style={{ width: `${(u.received / Math.max(1, u.size)) * 100}%` }} />
            </div>
          ) : null}
          <span className="hint">
            {u.status === "uploading" && `${fmtBytes(u.received)} из ${fmtBytes(u.size)}`}
            {u.status === "finishing" && "Проверяю файл…"}
            {u.status === "done" && "Загружено, обработка началась"}
            {u.status === "error" && `Ошибка: ${u.error ?? ""}. Выберите файл ещё раз — загрузка продолжится.`}
            {u.status === "uploading" && u.error ? ` · ${u.error}` : ""}
          </span>
        </div>
      ))}
      {stale.map((u) => (
        <div key={u.key} className="card row">
          <span className="grow hint">
            Не завершена: <b style={{ color: "var(--text)" }}>{u.name}</b> ({Math.round((u.received / u.size) * 100)}%). Выберите
            этот же файл, чтобы продолжить.
          </span>
          <button className="btn ghost" onClick={() => forget(u.key)}>
            Забыть
          </button>
        </div>
      ))}
    </div>
  );
};
