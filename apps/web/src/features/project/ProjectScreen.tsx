import { DEFAULT_FRAMING, DEFAULT_STYLE } from "@titler/core";
import { useEffect, useState } from "react";
import { cx } from "../../lib/format";
import { go, isTypingTarget } from "../../lib/hooks";
import { PlayerBar } from "../../player/PlayerBar";
import { Stage } from "../../player/Stage";
import { AudioTab } from "../audio/AudioTab";
import { ExportTab } from "../export/ExportTab";
import { useSeriesPlan } from "../export/series";
import { FrameTab, type FrameUi } from "../frame/FrameTab";
import { TextTab } from "../transcript/TextTab";
import { StatusChips } from "./StatusChips";
import { ProjectContext, useProject } from "./useProject";

export const TABS = [
  { id: "audio", label: "Звук" },
  { id: "text", label: "Текст" },
  { id: "frame", label: "Кадр" },
  { id: "export", label: "Экспорт" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

export const ProjectScreen = ({ id, tab }: { id: string; tab: TabId }) => {
  const ctx = useProject(id);
  const { view, player } = ctx;
  const [frameUi, setFrameUi] = useState<FrameUi>({ crop: false, safe: true });
  const plan = useSeriesPlan(view, ctx.rev?.doc ?? null);
  // On the export tab the preview shows each part as it will render (its own cue layout + «1/3»).
  const seriesPreview = tab === "export" && plan && plan.parts.length > 1 ? plan : null;

  // Player shortcuts only outside text input / the editor.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space" && (e.target as HTMLElement).tagName !== "BUTTON") {
        e.preventDefault();
        player.toggle();
      } else if (e.key === "j" || e.key === "J") player.skip(-2000);
      else if (e.key === "l" || e.key === "L") player.skip(2000);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [player]);

  useEffect(() => () => player.pause(), [player]);

  const settings = view?.project.settings;
  return (
    <ProjectContext.Provider value={ctx}>
      <header className="topbar">
        <button className="btn ghost icon" aria-label="К списку" onClick={() => go("")}>
          ‹
        </button>
        <h1>{view?.project.name ?? "…"}</h1>
        <StatusChips view={view} />
      </header>
      {ctx.error && !view ? <div className="banner err">Не удалось открыть проект: {ctx.error}</div> : null}
      {view ? (
        <div className="project">
          <div className="stage-wrap">
            <Stage
              view={view}
              player={player}
              doc={ctx.rev?.doc ?? null}
              framing={settings?.framing ?? DEFAULT_FRAMING}
              style={settings?.style ?? DEFAULT_STYLE}
              mode={tab === "frame" && frameUi.crop ? "crop" : "preview"}
              showSafe={tab === "frame" && frameUi.safe}
              onCrop={(cx, cy) => ctx.patchSettings({ framing: { keyframes: [{ t: 0, cx, cy }] } })}
              cues={seriesPreview?.cues ?? null}
              badges={seriesPreview?.badges}
            />
          </div>
          <nav className="tabs" aria-label="Этапы">
            {TABS.map((t) => (
              <a key={t.id} href={`#/p/${encodeURIComponent(id)}/${t.id}`} aria-current={t.id === tab ? "page" : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
          <div className={cx("content", `tab-${tab}`)}>
            {tab === "audio" && <AudioTab />}
            {tab === "text" && <TextTab />}
            {tab === "frame" && <FrameTab ui={frameUi} setUi={setFrameUi} />}
            {tab === "export" && <ExportTab plan={plan} />}
          </div>
          <div className="dock">
            <div ref={ctx.setDock} style={{ display: "contents" }} />
            {tab !== "audio" || !view.compare?.length ? <PlayerBar player={player} /> : null}
          </div>
        </div>
      ) : null}
    </ProjectContext.Provider>
  );
};
