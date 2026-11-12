import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { Hint } from "./tooltip";

type HintContent = string | (() => string);

const roots = new WeakMap<
  HTMLElement,
  { root: Root; revision: number; label?: string; content?: HintContent }
>();

function DomHint({ label, content }: { label: string; content: HintContent }) {
  const [hoverContent, setHoverContent] = useState("");
  return (
    <Hint content={typeof content === "string" ? content : hoverContent}>
      <span
        onPointerEnter={
          typeof content === "function"
            ? () => setHoverContent(content())
            : undefined
        }
      >
        {label}
      </span>
    </Hint>
  );
}

/** Render the same hints in CodeMirror's DOM-owned comment badges. */
export function renderDomHint(
  host: HTMLElement,
  label: string,
  content: HintContent,
) {
  let entry = roots.get(host);
  if (!entry) {
    entry = { root: createRoot(host), revision: 0 };
    roots.set(host, entry);
  }
  // Even unchanged content cancels a pending disposal when the host is reused.
  entry.revision += 1;
  if (entry.label === label && entry.content === content) return;
  entry.label = label;
  entry.content = content;
  entry.root.render(<DomHint label={label} content={content} />);
}

export function destroyDomHint(host: HTMLElement) {
  const entry = roots.get(host);
  if (!entry) return;
  const revision = entry.revision;
  // CodeMirror may dispose widgets while the enclosing React tree is committing.
  // A remount before this microtask reuses the root and cancels its disposal.
  queueMicrotask(() => {
    if (roots.get(host) !== entry || entry.revision !== revision) return;
    entry.root.unmount();
    roots.delete(host);
  });
}
