import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useProjectCtx } from "./useProject";

/** Renders tab-specific actions into the bottom dock, above the player bar. */
export const Dock = ({ children }: { children: ReactNode }) => {
  const { dock } = useProjectCtx();
  return dock ? createPortal(children, dock) : null;
};
