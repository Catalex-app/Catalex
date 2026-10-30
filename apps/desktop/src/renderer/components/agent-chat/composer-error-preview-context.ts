import { createContext, type ReactNode } from "react";

/** Optional harness recovery simulation; both paths render the shared error panel. */
export const ComposerErrorPreviewContext = createContext<
  ((info: { agentName: string; effort: string }) => ReactNode) | null
>(null);
