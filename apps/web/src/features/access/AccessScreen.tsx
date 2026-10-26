import type { AuthKey, AuthMe, LinkStats } from "@titler/core";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { fmtDate } from "../../lib/format";
import { go } from "../../lib/hooks";

// Login (public gateway only) and device keys for the app / scripts. See core/api.ts "Access".

export const LoginScreen = ({ onDone }: { onDone: () => void }) => {
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.login(token.trim());
      onDone();
    } catch (e) {
      setErr(e instanceof Error && e.message === "wrong token" ? "Неверный токен" : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <header className="topbar">
        <h1>Titler</h1>
      </header>
      <main className="scroll">
        <form
          className="section login"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2>Вход</h2>
          <p className="hint">Вы зашли из интернета — нужен токен владельца. Его выдаёт сервер: <code>pnpm --filter @titler/server auth owner</code>.</p>
          <label className="field">
            <span>Токен</span>
            <input className="text" type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="to_…" />
          </label>
          <button className="btn primary big" disabled={!token.trim() || busy}>
            Войти
          </button>
          {err ? <div className="banner err">{err}</div> : null}
        </form>
      </main>
    </>
  );
};

export const AccessScreen = () => {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [keys, setKeys] = useState<AuthKey[] | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; secret: string } | null>(null);
  const [links, setLinks] = useState<LinkStats | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const m = await api.authMe();
      setMe(m);
      const owner = m.via !== "key";
      setKeys(owner ? await api.listKeys() : null);
      setLinks(owner ? await api.linkStats() : null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setErr(null);
    try {
      const k = await api.createKey(name.trim());
      setFresh({ name: k.name, secret: k.secret });
      setName("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const revoke = async (id: string) => {
    if (!confirm("Отозвать ключ? Устройство с ним потеряет доступ.")) return;
    await api.revokeKey(id).catch((e: Error) => setErr(e.message));
    await load();
  };

  const rotate = async () => {
    setErr(null);
    try {
      setLinks(await api.rotateLinks());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setConfirmRotate(false);
  };
  const linksLive = !!links?.lastExpiresAt && new Date(links.lastExpiresAt).getTime() > Date.now();

  return (
    <>
      <header className="topbar">
        <button className="btn ghost icon" aria-label="К списку" onClick={() => go("")}>
          ‹
        </button>
        <h1>Доступ</h1>
      </header>
      <main className="scroll">
        <div className="section">
          <h2>Этот вход</h2>
          <p className="hint">
            {!me
              ? "…"
              : me.via === "local"
                ? "С этого устройства или из tailnet — вход не нужен."
                : me.via === "session"
                  ? `Вход по токену владельца${me.name ? ` «${me.name}»` : ""}.`
                  : `Ключ устройства «${me.name}».`}
          </p>
          {me?.via === "session" ? (
            <button className="btn" onClick={() => void api.logout().then(() => location.reload())}>
              Выйти
            </button>
          ) : null}
        </div>
        {keys ? (
          <div className="section">
            <h2>Ключи устройств</h2>
            <p className="hint">Для приложения и скриптов: заголовок <code>Authorization: Bearer …</code>. Ключ показывается один раз.</p>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input className="text grow" style={{ width: "auto" }} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Название, например iPhone" />
              <button className="btn primary" disabled={!name.trim()}>
                Создать
              </button>
            </form>
            {fresh ? (
              <div className="card secret">
                <b>Ключ «{fresh.name}»</b>
                <code>{fresh.secret}</code>
                <div className="row">
                  <button className="btn" onClick={() => void navigator.clipboard?.writeText(fresh.secret)}>
                    Скопировать
                  </button>
                  <button className="btn ghost" onClick={() => setFresh(null)}>
                    Сохранил
                  </button>
                </div>
              </div>
            ) : null}
            <div className="outs">
              {keys.map((k) => (
                <div className="out" key={k.id}>
                  <div style={{ minWidth: 0 }}>
                    <div className="t">
                      {k.name} {k.kind === "owner" ? <span className="chip">владелец</span> : null}
                    </div>
                    <div className="s">
                      создан {fmtDate(k.createdAt)}
                      {k.lastUsedAt ? ` · последний раз ${fmtDate(k.lastUsedAt)}` : " · не использовался"}
                      {k.revokedAt ? ` · отозван ${fmtDate(k.revokedAt)}` : ""}
                    </div>
                  </div>
                  {k.revokedAt ? null : (
                    <button className="btn danger" onClick={() => void revoke(k.id)}>
                      Отозвать
                    </button>
                  )}
                </div>
              ))}
              {!keys.length ? <p className="hint">Ключей пока нет.</p> : null}
            </div>
          </div>
        ) : null}
        {links ? (
          <div className="section">
            <h2>Ссылки на файлы</h2>
            <p className="hint">
              Подписанные ссылки для сервисов, которые забирают видео по адресу. Каждая работает до своего срока; сброс отключает все сразу.
            </p>
            <p className="hint">
              {links.rotatedAt ? `С последнего сброса (${fmtDate(links.rotatedAt)})` : "Всего"} выдано: {links.issued}
              {links.issued ? (linksLive ? ` · последняя действует до ${fmtDate(links.lastExpiresAt!)}` : " · все уже истекли") : ""}
            </p>
            {confirmRotate ? (
              <div className="card confirm">
                <b>Отключить все выданные ссылки?</b>
                <span className="hint">Они перестанут открываться сразу, в том числе у сервисов, которые ещё не забрали файл. Новые ссылки можно будет выдать как обычно.</span>
                <div className="row">
                  <button className="btn danger" onClick={() => void rotate()}>
                    Отключить все
                  </button>
                  <button className="btn ghost" onClick={() => setConfirmRotate(false)}>
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <div className="row">
                <button className="btn danger" onClick={() => setConfirmRotate(true)}>
                  Отключить все ссылки
                </button>
              </div>
            )}
          </div>
        ) : null}
        {err ? <div className="banner err">{err}</div> : null}
      </main>
    </>
  );
};
