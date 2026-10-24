import type { AspectRatio, CaptionLook, FitMode } from "@titler/core";
import { useProjectCtx } from "../project/useProject";

export interface FrameUi {
  crop: boolean;
  safe: boolean;
}

const RATIOS: [AspectRatio, string][] = [
  ["9:16", "9:16"],
  ["16:9", "16:9"],
  ["source", "Исходник"],
];
const FITS: [FitMode, string][] = [
  ["fill", "Заполнить"],
  ["fit_blur", "Размытие"],
  ["fit_solid", "Фон"],
];
const LOOK_LABELS: [CaptionLook, string][] = [
  ["bold", "Жирный"],
  ["clean", "Плашка"],
  ["focus", "Фокус"],
];

export const FrameTab = ({ ui, setUi }: { ui: FrameUi; setUi: (u: FrameUi) => void }) => {
  const { view, patchSettings } = useProjectCtx();
  const { framing, style } = view!.project.settings;
  const offset = framing.keyframes[0];

  return (
    <div className="scroll">
      <div className="section">
        <h2>Кадр</h2>
        <div className="seg" role="group" aria-label="Формат">
          {RATIOS.map(([r, l]) => (
            <button key={r} aria-pressed={framing.ratio === r} onClick={() => patchSettings({ framing: { ratio: r } })}>
              {l}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Заполнение">
          {FITS.map(([f, l]) => (
            <button key={f} aria-pressed={framing.fit === f} onClick={() => patchSettings({ framing: { fit: f } })}>
              {l}
            </button>
          ))}
        </div>
        {framing.fit === "fill" ? (
          <div className="row">
            <button className={ui.crop ? "btn on grow" : "btn grow"} aria-pressed={ui.crop} onClick={() => setUi({ ...ui, crop: !ui.crop })}>
              {ui.crop ? "Готово" : "Сдвинуть кадр"}
            </button>
            <button className="btn" disabled={!offset} onClick={() => patchSettings({ framing: { keyframes: [] } })}>
              По центру
            </button>
          </div>
        ) : (
          <p className="hint">Видео помещается целиком, ничего не обрезается.</p>
        )}
        {ui.crop ? <p className="hint">Перетащите рамку или коснитесь места, которое должно быть в центре. Затемнённое будет обрезано.</p> : null}
        {framing.ratio === "9:16" ? (
          <label className="switch">
            <input type="checkbox" checked={ui.safe} onChange={(e) => setUi({ ...ui, safe: e.target.checked })} />
            Показать зоны интерфейса Reels / TikTok
          </label>
        ) : null}
      </div>
      <div className="section">
        <h2>Субтитры</h2>
        <div className="seg" role="group" aria-label="Стиль">
          {LOOK_LABELS.map(([k, l]) => (
            <button key={k} aria-pressed={style.look === k} onClick={() => patchSettings({ style: { look: k } })}>
              {l}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Длина строки: до {style.maxChars} символов</span>
          <input
            type="range"
            min={12}
            max={40}
            step={1}
            value={style.maxChars}
            onChange={(e) => patchSettings({ style: { maxChars: Number(e.target.value) } })}
          />
        </label>
        <div className="seg" role="group" aria-label="Строк">
          {([1, 2] as const).map((n) => (
            <button key={n} aria-pressed={style.maxLines === n} onClick={() => patchSettings({ style: { maxLines: n } })}>
              {n === 1 ? "Одна строка" : "Две строки"}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Высота: {Math.round((1 - style.y) * 100)}% от низа</span>
          <input
            type="range"
            min={0.3}
            max={0.95}
            step={0.01}
            value={style.y}
            onChange={(e) => patchSettings({ style: { y: Number(e.target.value) } })}
          />
        </label>
        <label className="switch">
          <input type="checkbox" checked={style.wordHighlight} onChange={(e) => patchSettings({ style: { wordHighlight: e.target.checked } })} />
          Подсвечивать текущее слово
        </label>
        <p className="hint">Превью рисуется тем же разбиением и шрифтом, что и экспорт.</p>
      </div>
    </div>
  );
};
