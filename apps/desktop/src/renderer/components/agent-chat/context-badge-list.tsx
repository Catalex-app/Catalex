import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./context-badge-list.css";

import type { ChatContextBadge } from "@/lib/chat-context";
export type { ChatContextBadge } from "@/lib/chat-context";

interface Entry {
  id: number;
  context: ChatContextBadge;
  content: ReactNode;
  animateEntrance: boolean;
  attention: boolean;
  exitingAt?: number;
}

const EXIT_MS = 120;
const keyOf = (context: ChatContextBadge) =>
  context.selectionKey ?? `${context.label}\u0000${context.selectedText}`;

/** Preserve badge identity while a live selection changes or becomes pinned. */
export function ContextBadgeList({
  contexts,
  compact = false,
  isLive,
  renderContext,
}: {
  contexts: ChatContextBadge[];
  compact?: boolean;
  isLive: (context: ChatContextBadge) => boolean;
  renderContext: (context: ChatContextBadge, index: number) => ReactNode;
}) {
  const nextId = useRef(0);
  const [previousContexts, setPreviousContexts] = useState(contexts);
  const [entries, setEntries] = useState<Entry[]>(() =>
    contexts.map((context, index) => ({
      id: nextId.current++,
      context,
      animateEntrance: true,
      attention: false,
      content: renderContext(context, index),
    })),
  );
  const shellRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const heightAnimation = useRef<Animation | null>(null);
  const positions = useRef(new Map<number, { left: number; top: number }>());

  // Derive presence before React commits, so removals retain their layout for
  // the fade and rapid replacements never flash an empty context row.
  if (previousContexts !== contexts) {
    const available = [...entries];
    const next = contexts.map((context, index) => {
      let match = available.findIndex(
        (entry) => keyOf(entry.context) === keyOf(context),
      );
      if (match < 0 && isLive(context))
        match = available.findIndex(
          (entry) => entry.exitingAt === undefined && isLive(entry.context),
        );
      // A new drag briefly clears the old selection. Reclaim its fading
      // badge instead of inserting a second badge beside the exit placeholder.
      if (match < 0 && isLive(context))
        match = available.findIndex((entry) => isLive(entry.context));
      const prior = match < 0 ? undefined : available.splice(match, 1)[0];
      return {
        id: prior?.id ?? nextId.current++,
        animateEntrance: prior
          ? prior.exitingAt === undefined && prior.animateEntrance
          : true,
        attention:
          prior?.attention ??
          (entries.length === 0 && index === 0 && isLive(context)),
        context,
        content: renderContext(context, index),
      };
    });
    const retained: Entry[] = [...next];
    for (const old of entries) {
      if (next.some((entry) => entry.id === old.id)) continue;
      const exit = { ...old, exitingAt: old.exitingAt ?? Date.now() };
      retained.splice(Math.min(entries.indexOf(old), retained.length), 0, exit);
    }
    setPreviousContexts(contexts);
    setEntries(retained);
  }

  useEffect(() => {
    const deadlines = entries.flatMap((entry) =>
      entry.exitingAt === undefined ? [] : [entry.exitingAt + EXIT_MS],
    );
    if (!deadlines.length) return;
    const timer = window.setTimeout(
      () => {
        setEntries((current) =>
          current.filter(
            (entry) =>
              entry.exitingAt === undefined ||
              entry.exitingAt + EXIT_MS > Date.now(),
          ),
        );
      },
      Math.max(0, Math.min(...deadlines) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [entries]);

  useLayoutEffect(() => {
    const shell = shellRef.current!;
    const row = rowRef.current!;
    const resize = () => {
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const target = row.getBoundingClientRect().height;
      if (shell.style.height !== `${target}px`) {
        const current = shell.getBoundingClientRect().height;
        heightAnimation.current?.cancel();
        shell.style.height = `${target}px`;
        heightAnimation.current =
          !reduced && Math.abs(current - target) > 0.5
            ? shell.animate(
                [{ height: `${current}px` }, { height: `${target}px` }],
                {
                  duration: 220,
                  easing: "cubic-bezier(0.2, 0, 0.2, 1)",
                },
              )
            : null;
      }
      const nextPositions = new Map<number, { left: number; top: number }>();
      for (const element of row.querySelectorAll<HTMLElement>(
        "[data-context-entry]",
      )) {
        const id = Number(element.dataset.contextEntry);
        const next = { left: element.offsetLeft, top: element.offsetTop };
        const previous = positions.current.get(id);
        if (
          !reduced &&
          previous &&
          (previous.left !== next.left || previous.top !== next.top)
        ) {
          element.animate(
            [
              {
                translate: `${previous.left - next.left}px ${previous.top - next.top}px`,
              },
              { translate: "0px 0px" },
            ],
            { duration: 180, easing: "cubic-bezier(0.2, 0, 0.2, 1)" },
          );
        }
        nextPositions.set(id, next);
      }
      positions.current = nextPositions;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(row);
    return () => observer.disconnect();
  }, [entries]);

  useEffect(() => () => heightAnimation.current?.cancel(), []);

  return (
    <div
      ref={shellRef}
      data-context-row-shell="true"
      className="relative shrink-0 overflow-hidden"
      style={{ height: 0 }}
    >
      <div
        ref={rowRef}
        className={`relative space-y-1.5 ${compact ? (entries.length ? "pb-1" : "") : `pr-4 pl-3 ${entries.length ? "pt-3" : ""}`}`}
      >
        {[
          entries.filter(
            (entry) => entry.context.attachment || entry.context.imageDataUrl,
          ),
          entries.filter(
            (entry) =>
              !entry.context.attachment &&
              !entry.context.imageDataUrl &&
              !entry.context.comment,
          ),
          entries.filter(
            (entry) =>
              !entry.context.attachment &&
              !entry.context.imageDataUrl &&
              entry.context.comment,
          ),
        ].map(
          (group, index) =>
            group.length > 0 && (
              <div
                key={index}
                data-context-kind={
                  ["attachment", "selection", "comment"][index]
                }
                className="flex flex-wrap items-center gap-1.5"
              >
                {group.map((entry) => (
                  <div
                    key={entry.id}
                    data-context-entry={entry.id}
                    data-context-enter={entry.animateEntrance}
                    data-context-attention={entry.attention}
                    data-context-presence={
                      entry.exitingAt === undefined ? "present" : "exiting"
                    }
                    className="context-badge-presence inline-flex max-w-full"
                    inert={entry.exitingAt !== undefined}
                    aria-hidden={entry.exitingAt !== undefined || undefined}
                  >
                    {entry.exitingAt === undefined
                      ? renderContext(
                          entry.context,
                          contexts.indexOf(entry.context),
                        )
                      : entry.content}
                  </div>
                ))}
              </div>
            ),
        )}
      </div>
    </div>
  );
}
