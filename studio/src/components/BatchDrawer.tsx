import { useState } from "react";
import { Btn, DeviceIcon, IconBtn, SectionLabel } from "../primitives";
import { FONTS, type Tok } from "../tokens";
import type { CaptionStyle } from "@titler/remotion/src/types";

const STYLE_LABEL: Record<CaptionStyle, string> = {
  bold: "Bold",
  clean: "Clean",
  focus: "Focus",
};

export const BatchDrawer: React.FC<{
  tok: Tok;
  inbox: string[];
  captionStyle: CaptionStyle;
  watermark: boolean;
  onClose: () => void;
  onRun: (files: string[], withRender: boolean) => Promise<void> | void;
}> = ({ tok, inbox, captionStyle, watermark, onClose, onRun }) => {
  const [sel, setSel] = useState<Set<string>>(new Set(inbox));
  const [withRender, setWithRender] = useState(true);

  const toggle = (f: string) => {
    const n = new Set(sel);
    if (n.has(f)) n.delete(f);
    else n.add(f);
    setSel(n);
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50 }}>
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.3)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: 520,
          maxWidth: "92vw",
          background: tok.paper,
          borderLeft: `1px solid ${tok.rule}`,
          display: "flex",
          flexDirection: "column",
          boxShadow: "-20px 0 60px -20px rgba(0,0,0,0.2)",
        }}
      >
        <div
          style={{
            padding: "20px 24px",
            borderBottom: `1px solid ${tok.rule}`,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div>
            <SectionLabel tok={tok}>Process many files</SectionLabel>
            <div
              style={{
                fontFamily: FONTS.display,
                fontStyle: "italic",
                fontWeight: 500,
                fontSize: 24,
                color: tok.ink,
                letterSpacing: -0.4,
                marginTop: 2,
              }}
            >
              Batch
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <IconBtn name="x" tok={tok} size={30} onClick={onClose} title="close" />
        </div>

        <div style={{ padding: "20px 24px", overflow: "auto", flex: 1 }}>
          <SectionLabel tok={tok}>
            Inbox · {inbox.length} file{inbox.length === 1 ? "" : "s"}
          </SectionLabel>
          {inbox.length === 0 && (
            <div
              style={{
                marginTop: 14,
                padding: 18,
                border: `1px dashed ${tok.rule}`,
                borderRadius: 6,
                color: tok.ink3,
                fontFamily: FONTS.display,
                fontStyle: "italic",
                textAlign: "center",
              }}
            >
              Inbox is empty. Drop video files into the watch folder.
            </div>
          )}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginTop: 8,
            }}
          >
            {inbox.map((f) => {
              const name = f.split("/").pop() ?? f;
              const checked = sel.has(f);
              return (
                <label
                  key={f}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    border: `1px solid ${tok.rule}`,
                    borderRadius: 6,
                    background: checked ? tok.accentSoft : tok.card,
                    cursor: "pointer",
                    transition: "all 0.12s ease",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(f)}
                    style={{ accentColor: tok.accent }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {name}
                    </div>
                  </div>
                  <DeviceIcon device="iPhone" size={14} color={tok.ink3} />
                </label>
              );
            })}
          </div>

          <div style={{ height: 20 }} />
          <SectionLabel tok={tok}>Settings</SectionLabel>
          <div
            style={{
              padding: 14,
              border: `1px solid ${tok.rule}`,
              borderRadius: 6,
              background: tok.card,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              marginTop: 8,
            }}
          >
            <Row tok={tok} label="Caption style" value={STYLE_LABEL[captionStyle]} />
            <Row tok={tok} label="Watermark" value={watermark ? "on" : "off"} />
            <Row tok={tok} label="Aspect" value="9:16 crop" />
          </div>

          <div style={{ height: 16 }} />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              border: `1px solid ${tok.rule}`,
              borderRadius: 6,
              background: tok.card,
              cursor: "pointer",
              fontSize: 13,
              color: tok.ink2,
            }}
          >
            <input
              type="checkbox"
              checked={withRender}
              onChange={() => setWithRender((v) => !v)}
              style={{ accentColor: tok.accent }}
            />
            Render immediately after import (use {STYLE_LABEL[captionStyle]} style)
          </label>
        </div>

        <div
          style={{
            padding: "16px 24px",
            borderTop: `1px solid ${tok.rule}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: tok.card,
          }}
        >
          <div style={{ fontSize: 12, color: tok.ink3 }}>
            {sel.size} of {inbox.length} selected
          </div>
          <div style={{ flex: 1 }} />
          <Btn tok={tok} variant="outline" size="md" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            tok={tok}
            variant="accent"
            size="md"
            icon="render"
            onClick={() => onRun([...sel], withRender)}
            disabled={sel.size === 0}
          >
            {withRender ? `Import & render ${sel.size}` : `Import ${sel.size}`}
          </Btn>
        </div>
      </div>
    </div>
  );
};

const Row = ({ tok, label, value }: { tok: Tok; label: string; value: string }) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    }}
  >
    <div style={{ fontSize: 12, color: tok.ink2 }}>{label}</div>
    <div
      style={{
        fontFamily: FONTS.display,
        fontStyle: "italic",
        fontWeight: 500,
        fontSize: 14,
        color: tok.ink,
        letterSpacing: -0.1,
      }}
    >
      {value}
    </div>
  </div>
);
