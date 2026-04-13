import { useCallback, useEffect, useState } from "react";
import {
  listOutputs,
  deleteOutput,
  revealOutputs,
  type OutputFile,
} from "../api";

const fmtSize = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const OutputsPanel: React.FC = () => {
  const [files, setFiles] = useState<OutputFile[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setFiles(await listOutputs());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const onDelete = async (name: string) => {
    if (!confirm(`Delete ${name}?`)) return;
    await deleteOutput(name);
    refresh();
  };

  return (
    <div style={{ borderTop: "1px solid #2c2c33", padding: "6px 8px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
        }}
        onClick={() => setOpen(!open)}
      >
        <span style={{ fontSize: 10, color: "#666" }}>
          {open ? "\u25BC" : "\u25B6"}
        </span>
        <h2 style={{ flex: 1, fontSize: 11, color: "#888", margin: 0 }}>
          outputs ({files.length})
        </h2>
        <button
          onClick={(e) => {
            e.stopPropagation();
            revealOutputs();
          }}
          style={{ fontSize: 9, padding: "2px 5px", color: "#888" }}
        >
          open folder
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 4 }}>
          {files.length === 0 && (
            <div style={{ fontSize: 10, color: "#555", padding: 4 }}>
              no renders yet
            </div>
          )}
          {files.map((f) => (
            <div
              key={f.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 0",
                fontSize: 11,
              }}
            >
              <a
                href={`/api/out/${encodeURIComponent(f.name)}`}
                download
                style={{
                  flex: 1,
                  color: "#aaa",
                  textDecoration: "none",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={f.name}
              >
                {f.name}
              </a>
              <span style={{ fontSize: 9, color: "#555", flexShrink: 0 }}>
                {fmtSize(f.size)}
              </span>
              <button
                onClick={() => onDelete(f.name)}
                style={{
                  fontSize: 9,
                  padding: "1px 4px",
                  color: "#ef4444",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
