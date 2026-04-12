import { useCallback, useState } from "react";
import type { TextOverlay } from "../api";

type Props = {
  overlays: TextOverlay[];
  currentTime: number;
  duration: number;
  onChange: (overlays: TextOverlay[]) => void;
};

const DEFAULT_OVERLAY: Omit<TextOverlay, "id"> = {
  text: "Text",
  x: 540,
  y: 960,
  start: 0,
  end: 5,
  fontSize: 48,
  color: "#FFFFFF",
  fontWeight: 700,
  outline: true,
};

let nextId = 1;
const genId = () => `ov_${nextId++}_${Date.now()}`;

export const OverlayEditor: React.FC<Props> = ({
  overlays,
  currentTime,
  duration,
  onChange,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);

  const addOverlay = useCallback(() => {
    const ov: TextOverlay = {
      ...DEFAULT_OVERLAY,
      id: genId(),
      start: Math.max(0, currentTime - 0.5),
      end: Math.min(duration, currentTime + 4),
    };
    onChange([...overlays, ov]);
    setEditingId(ov.id);
  }, [overlays, currentTime, duration, onChange]);

  const updateOverlay = useCallback(
    (id: string, patch: Partial<TextOverlay>) => {
      onChange(
        overlays.map((ov) => (ov.id === id ? { ...ov, ...patch } : ov)),
      );
    },
    [overlays, onChange],
  );

  const removeOverlay = useCallback(
    (id: string) => {
      onChange(overlays.filter((ov) => ov.id !== id));
      if (editingId === id) setEditingId(null);
    },
    [overlays, editingId, onChange],
  );

  const editing = overlays.find((ov) => ov.id === editingId);

  return (
    <div style={{ fontSize: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <span style={{ flex: 1, color: "#888", fontSize: 11 }}>
          overlays ({overlays.length})
        </span>
        <button
          onClick={addOverlay}
          style={{ fontSize: 11, padding: "3px 8px" }}
        >
          + add text
        </button>
      </div>

      {overlays.map((ov) => {
        const active =
          currentTime >= ov.start && currentTime < ov.end;
        return (
          <div
            key={ov.id}
            onClick={() => setEditingId(ov.id)}
            style={{
              padding: "4px 6px",
              marginBottom: 2,
              borderRadius: 4,
              cursor: "pointer",
              background:
                editingId === ov.id
                  ? "#2a2a33"
                  : active
                    ? "rgba(250,204,21,0.08)"
                    : "transparent",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: ov.color,
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, color: "#ccc" }}>
              {ov.text.length > 20
                ? ov.text.slice(0, 18) + "\u2026"
                : ov.text}
            </span>
            <span style={{ color: "#666", fontSize: 10 }}>
              {ov.start.toFixed(1)}s–{ov.end.toFixed(1)}s
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeOverlay(ov.id);
              }}
              style={{
                fontSize: 10,
                padding: "1px 4px",
                color: "#ef4444",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
        );
      })}

      {editing && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: "#1d1d22",
            borderRadius: 6,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <input
            type="text"
            value={editing.text}
            onChange={(e) =>
              updateOverlay(editing.id, { text: e.target.value })
            }
            style={{
              font: "inherit",
              fontSize: 13,
              background: "#2a2a33",
              color: "#e6e6e6",
              border: "1px solid #3a3a44",
              borderRadius: 4,
              padding: "4px 8px",
            }}
          />

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#888" }}>start</span>
              <input
                type="number"
                value={editing.start}
                step={0.1}
                min={0}
                onChange={(e) =>
                  updateOverlay(editing.id, {
                    start: Number(e.target.value),
                  })
                }
                style={{
                  width: 55,
                  font: "inherit",
                  fontSize: 11,
                  background: "#2a2a33",
                  color: "#e6e6e6",
                  border: "1px solid #3a3a44",
                  borderRadius: 3,
                  padding: "2px 4px",
                }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#888" }}>end</span>
              <input
                type="number"
                value={editing.end}
                step={0.1}
                min={0}
                onChange={(e) =>
                  updateOverlay(editing.id, {
                    end: Number(e.target.value),
                  })
                }
                style={{
                  width: 55,
                  font: "inherit",
                  fontSize: 11,
                  background: "#2a2a33",
                  color: "#e6e6e6",
                  border: "1px solid #3a3a44",
                  borderRadius: 3,
                  padding: "2px 4px",
                }}
              />
            </label>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#888" }}>x</span>
              <input
                type="number"
                value={editing.x}
                step={10}
                onChange={(e) =>
                  updateOverlay(editing.id, { x: Number(e.target.value) })
                }
                style={{
                  width: 55,
                  font: "inherit",
                  fontSize: 11,
                  background: "#2a2a33",
                  color: "#e6e6e6",
                  border: "1px solid #3a3a44",
                  borderRadius: 3,
                  padding: "2px 4px",
                }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#888" }}>y</span>
              <input
                type="number"
                value={editing.y}
                step={10}
                onChange={(e) =>
                  updateOverlay(editing.id, { y: Number(e.target.value) })
                }
                style={{
                  width: 55,
                  font: "inherit",
                  fontSize: 11,
                  background: "#2a2a33",
                  color: "#e6e6e6",
                  border: "1px solid #3a3a44",
                  borderRadius: 3,
                  padding: "2px 4px",
                }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ color: "#888" }}>size</span>
              <input
                type="number"
                value={editing.fontSize}
                step={2}
                min={12}
                max={200}
                onChange={(e) =>
                  updateOverlay(editing.id, {
                    fontSize: Number(e.target.value),
                  })
                }
                style={{
                  width: 45,
                  font: "inherit",
                  fontSize: 11,
                  background: "#2a2a33",
                  color: "#e6e6e6",
                  border: "1px solid #3a3a44",
                  borderRadius: 3,
                  padding: "2px 4px",
                }}
              />
            </label>
          </div>

          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="color"
              value={editing.color}
              onChange={(e) =>
                updateOverlay(editing.id, { color: e.target.value })
              }
              style={{ width: 28, height: 22, border: "none", padding: 0 }}
            />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 3,
                color: "#888",
              }}
            >
              <input
                type="checkbox"
                checked={editing.fontWeight >= 700}
                onChange={(e) =>
                  updateOverlay(editing.id, {
                    fontWeight: e.target.checked ? 700 : 400,
                  })
                }
              />
              bold
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 3,
                color: "#888",
              }}
            >
              <input
                type="checkbox"
                checked={editing.outline}
                onChange={(e) =>
                  updateOverlay(editing.id, { outline: e.target.checked })
                }
              />
              outline
            </label>
          </div>
        </div>
      )}
    </div>
  );
};
