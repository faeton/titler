import { useEffect, useRef, useState } from "react";

/** Tracks the visual viewport so the shell can shrink above an on-screen keyboard. */
export const useVisualViewport = () => {
  const [kb, setKb] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const update = () => {
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      root.style.setProperty("--vvh", `${h}px`);
      root.style.setProperty("--vvtop", `${top}px`);
      const open = !!vv && window.innerHeight - h > 120;
      root.classList.toggle("kb-open", open);
      setKb(open);
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return kb;
};

export const useInterval = (fn: () => void, ms: number | null) => {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
};

/** Hash routing: #/ and #/p/<id>/<tab>. */
export const useHashRoute = (): string[] => {
  const parse = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(parse);
  useEffect(() => {
    const on = () => setParts(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
};

export const go = (...parts: string[]) => {
  location.hash = "#/" + parts.map(encodeURIComponent).join("/");
};

export const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};
