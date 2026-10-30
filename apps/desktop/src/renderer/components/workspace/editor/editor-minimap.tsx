import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { EditorView } from "@codemirror/view";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { ListFilterIcon } from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { type GitLineChange } from "./git-line-changes";
import type { InlineEditorComment } from "./inline-comments";
import type { DiagnosticItem } from "./problems-panel";
import {
  buildMinimapMarkers,
  clusterMinimapMarkers,
  type MinimapLayer,
  type MinimapMarker,
  type MinimapCluster,
} from "./editor-minimap-model";
import { threeWayMergeField } from "./three-way-merge-extension";
import "./editor-minimap.css";

const UPDATE_EVENT = "catalex:minimap-update";
export const editorMinimapUpdateListener = EditorView.updateListener.of(
  (update) => {
    if (
      update.docChanged ||
      update.geometryChanged ||
      update.viewportChanged ||
      getChunks(update.startState)?.chunks !==
        getChunks(update.state)?.chunks ||
      update.startState.field(threeWayMergeField, false)?.regions !==
        update.state.field(threeWayMergeField, false)?.regions
    ) {
      update.view.dom.dispatchEvent(new Event(UPDATE_EVENT));
    }
  },
);

const layerGroups: { label: string; layers: MinimapLayer[] }[] = [
  { label: "Git changes", layers: ["changes"] },
  { label: "Comments", layers: ["human", "agent"] },
  { label: "LaTeX errors & warnings", layers: ["errors", "warnings"] },
];

function readSnapshot(view: EditorView) {
  const review = getChunks(view.state);
  return {
    doc: view.state.doc,
    chunks: review?.chunks,
    regions: view.state.field(threeWayMergeField, false)?.regions,
    original: review ? getOriginalDoc(view.state) : undefined,
  };
}

function lineLabel(marker: MinimapMarker) {
  return marker.line === marker.endLine
    ? `Line ${marker.line}`
    : `Lines ${marker.line}–${marker.endLine}`;
}

function reviewStackStyle(marker: MinimapMarker): CSSProperties | undefined {
  if (marker.kind !== "review" && marker.kind !== "conflict") return;
  const palette =
    marker.kind === "conflict"
      ? { ancestor: "#94a3b8", current: "#3b82f6", proposed: "#a855f7" }
      : { ancestor: "#94a3b8", current: "#ef4444", proposed: "#22c55e" };
  const colors = marker.reviewVersions?.length
    ? marker.reviewVersions.map((version) => palette[version])
    : ["#94a3b8"];
  const stops = colors.flatMap((color, index) => [
    ...(index ? [`transparent ${index * 4 - 1}px ${index * 4}px`] : []),
    `${color} ${index * 4}px ${index * 4 + 3}px`,
  ]);
  return {
    "--review-stack": `linear-gradient(to bottom, ${stops.join(", ")})`,
    "--review-height": `${colors.length * 4 - 1}px`,
  } as CSSProperties;
}

function MinimapMark({
  cluster,
  tabIndex,
  onFocus,
  onNavigate,
  onMoveFocus,
}: {
  cluster: MinimapCluster;
  tabIndex: number;
  onFocus: () => void;
  onNavigate: (markers: MinimapMarker[]) => void;
  onMoveFocus: (direction: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dismissedByNavigation = useRef(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const index = Math.min(selectedIndex, cluster.markers.length - 1);
  const marker = cluster.markers[index];
  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        // Ignore a delayed hover/focus open after navigation moved the pointer.
        if (
          !next ||
          (!dismissedByNavigation.current &&
            (buttonRef.current?.matches(":hover") ||
              buttonRef.current === document.activeElement ||
              cardRef.current?.matches(":hover")))
        )
          setOpen(next);
      }}
      openDelay={180}
      closeDelay={120}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          ref={buttonRef}
          className="editor-minimap-mark"
          data-minimap-marker={marker.kind}
          data-minimap-line={marker.line}
          data-minimap-lane={cluster.lane}
          aria-label={`${marker.title}, ${lineLabel(marker).toLowerCase()}${cluster.markers.length > 1 ? `, ${index + 1} of ${cluster.markers.length} nearby items` : ""}`}
          tabIndex={tabIndex}
          style={{ top: cluster.top, height: cluster.height }}
          onPointerEnter={() => {
            dismissedByNavigation.current = false;
          }}
          onPointerDown={(event) => {
            // Mouse focus would reopen the card after the outside-press dismissal.
            event.preventDefault();
            dismissedByNavigation.current = true;
            setOpen(false);
          }}
          onFocus={(event) => {
            event.preventDefault();
            dismissedByNavigation.current = false;
            onFocus();
            setOpen(true);
          }}
          onBlur={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          onClick={() => {
            dismissedByNavigation.current = true;
            setOpen(false);
            onNavigate(cluster.markers);
          }}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              onMoveFocus(
                event.key === "Home"
                  ? -Infinity
                  : event.key === "End"
                    ? Infinity
                    : event.key === "ArrowDown"
                      ? 1
                      : -1,
              );
            } else if (
              event.key === "ArrowRight" ||
              event.key === "ArrowLeft"
            ) {
              event.preventDefault();
              setSelectedIndex(
                (index) =>
                  (index +
                    (event.key === "ArrowRight"
                      ? 1
                      : cluster.markers.length - 1)) %
                  cluster.markers.length,
              );
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
            }
          }}
        >
          <span className="editor-minimap-colors">
            {[
              ...new Map(
                cluster.markers.map((item) => [
                  `${item.kind}:${item.reviewVersions?.join(",") ?? ""}`,
                  item,
                ]),
              ).entries(),
            ].map(([key, item]) => (
              <span
                key={key}
                className="editor-minimap-stroke"
                data-kind={item.kind}
                data-review-versions={item.reviewVersions?.join(" ")}
                style={reviewStackStyle(item)}
              />
            ))}
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        ref={cardRef}
        side="left"
        sideOffset={9}
        collisionPadding={12}
        className="editor-minimap-card"
      >
        {cluster.markers.length > 1 && (
          <div className="editor-minimap-card-heading">
            {cluster.markers.length} nearby items <span>← → to browse</span>
          </div>
        )}
        <div className="editor-minimap-card-items">
          {open &&
            cluster.markers.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="editor-minimap-card-item"
                data-active={index === selectedIndex}
                onClick={() => {
                  dismissedByNavigation.current = true;
                  setOpen(false);
                  onNavigate([item]);
                }}
              >
                <span className="editor-minimap-card-title">
                  <span
                    className="editor-minimap-dot"
                    data-kind={item.kind}
                    data-review-versions={item.reviewVersions?.join(" ")}
                    style={reviewStackStyle(item)}
                  />
                  {item.title}
                  <span>{lineLabel(item)}</span>
                </span>
                {item.before && (
                  <span className="editor-minimap-before">{item.before}</span>
                )}
                {item.detail && (
                  <span className="editor-minimap-detail">{item.detail}</span>
                )}
              </button>
            ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function EditorMinimap({
  view,
  gitChanges,
  comments,
  diagnostics,
  isConflict,
  onNavigateMarkers,
}: {
  view: EditorView;
  gitChanges: GitLineChange[];
  gitHeadContent: string | null | undefined;
  comments: InlineEditorComment[];
  diagnostics: DiagnosticItem[];
  isConflict: boolean;
  onNavigateMarkers: (markers: MinimapMarker[]) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState(() => readSnapshot(view));
  const [geometry, setGeometry] = useState({
    height: 1,
    first: 1,
    last: 1,
    scrollTop: 0,
    scrollHeight: 1,
    clientHeight: 1,
    width: 1,
    background: "var(--background)",
  });
  const viewportRef = useRef<HTMLSpanElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const layers = useSettingsStore((state) => state.editorMinimapLayers);
  const setLayer = useSettingsStore((state) => state.setEditorMinimapLayer);
  const dragging = useRef<{
    pointerId: number;
    offset: number;
    top: number;
    travel: number;
    maxScroll: number;
    handleTop: number;
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    let frame = 0;
    const measure = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (disposed || !view.dom.isConnected) return;
        const next = readSnapshot(view);
        setSnapshot((current) =>
          current.doc === next.doc &&
          current.chunks === next.chunks &&
          current.original === next.original &&
          current.regions === next.regions
            ? current
            : next,
        );
        view.requestMeasure({
          key: trackRef,
          read: () => {
            const rect = view.scrollDOM.getBoundingClientRect();
            const top = Math.max(0, rect.top - view.documentTop);
            const bottom = Math.max(top, rect.bottom - view.documentTop);
            const first = view.state.doc.lineAt(
              view.lineBlockAtHeight(top).from,
            ).number;
            const last = view.state.doc.lineAt(
              view.lineBlockAtHeight(bottom).to,
            ).number;
            return {
              height: trackRef.current?.clientHeight ?? 1,
              first,
              last,
              scrollTop: view.scrollDOM.scrollTop,
              scrollHeight: view.scrollDOM.scrollHeight,
              clientHeight: view.scrollDOM.clientHeight,
              width: rect.width,
              background: getComputedStyle(view.dom).backgroundColor,
            };
          },
          write: (nextGeometry) => {
            if (disposed) return;
            setGeometry((current) =>
              current.height === nextGeometry.height &&
              current.first === nextGeometry.first &&
              current.last === nextGeometry.last &&
              current.scrollTop === nextGeometry.scrollTop &&
              current.scrollHeight === nextGeometry.scrollHeight &&
              current.clientHeight === nextGeometry.clientHeight &&
              current.width === nextGeometry.width &&
              current.background === nextGeometry.background
                ? current
                : nextGeometry,
            );
          },
        });
      });
    };
    const resize = new ResizeObserver(measure);
    if (trackRef.current) resize.observe(trackRef.current);
    resize.observe(view.scrollDOM);
    // Theme changes can recolor the editor without changing its geometry.
    const themeObserver = new MutationObserver(measure);
    themeObserver.observe(view.dom, {
      attributes: true,
      attributeFilter: ["class"],
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    view.dom.addEventListener(UPDATE_EVENT, measure);
    view.scrollDOM.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      themeObserver.disconnect();
      view.dom.removeEventListener(UPDATE_EVENT, measure);
      view.scrollDOM.removeEventListener("scroll", measure);
    };
  }, [view]);

  const isReview = snapshot.chunks !== undefined || isConflict;
  const isFiltered =
    !isReview &&
    layerGroups.some((group) => group.layers.some((layer) => !layers[layer]));
  const markers = useMemo<MinimapMarker[]>(
    () =>
      isConflict && !snapshot.chunks
        ? [
            {
              id: "whole-file-conflict",
              layer: "changes",
              kind: "conflict",
              from: 0,
              line: 1,
              endLine: snapshot.doc.lines,
              title: "Unresolved file conflict",
              detail:
                "Choose whether to keep or delete this file using the review controls.",
            },
          ]
        : buildMinimapMarkers(
            snapshot.doc,
            isReview ? [] : gitChanges,
            isReview ? [] : comments,
            isReview ? [] : diagnostics,
            snapshot.chunks && snapshot.original
              ? {
                  chunks: snapshot.chunks,
                  original: snapshot.original,
                  conflict: isConflict,
                  regions: snapshot.regions,
                }
              : undefined,
          ),
    [snapshot, gitChanges, comments, diagnostics, isConflict, isReview],
  );
  const [clusters, setClusters] = useState<MinimapCluster[]>([]);
  useEffect(() => {
    let disposed = false;
    view.requestMeasure({
      read: () => {
        const scroller = view.scrollDOM;
        const height = trackRef.current?.clientHeight ?? 1;
        const handleHeight = Math.min(
          height,
          Math.max(
            12,
            (height * scroller.clientHeight) /
              Math.max(1, scroller.scrollHeight),
          ),
        );
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        const scale =
          maxScroll > 0
            ? (height - handleHeight) / maxScroll
            : height / Math.max(1, scroller.scrollHeight);
        const inset =
          maxScroll > 0
            ? (handleHeight - scroller.clientHeight * scale) / 2
            : 0;
        // CodeMirror blocks use document coordinates; scrollTop also includes padding.
        const documentOffset =
          view.documentTop -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop;
        const positions = new Map<string, { top: number; bottom: number }>();
        for (const marker of markers) {
          const from = Math.min(marker.from, view.state.doc.length);
          const start = view.lineBlockAt(from);
          const end = view.lineBlockAt(
            view.state.doc.line(Math.min(marker.endLine, view.state.doc.lines))
              .from,
          );
          positions.set(marker.id, {
            top:
              inset + (documentOffset + (start.top + start.bottom) / 2) * scale,
            bottom:
              inset + (documentOffset + (end.top + end.bottom) / 2) * scale,
          });
        }
        return clusterMinimapMarkers(
          markers,
          view.state.doc.lines,
          height,
          layers,
          positions,
        );
      },
      write: (next) => {
        if (!disposed) setClusters(next);
      },
    });
    return () => {
      disposed = true;
    };
  }, [view, markers, layers, geometry]);
  const activeId = clusters.some((cluster) => cluster.id === focusedId)
    ? focusedId
    : clusters[0]?.id;
  const lineCount = snapshot.doc.lines;
  const viewportHeight = Math.min(
    geometry.height,
    Math.max(
      12,
      (geometry.clientHeight / Math.max(1, geometry.scrollHeight)) *
        geometry.height,
    ),
  );
  const viewportTop =
    dragging.current?.handleTop ??
    Math.min(
      geometry.height - viewportHeight,
      (Math.max(0, geometry.scrollTop) /
        Math.max(1, geometry.scrollHeight - geometry.clientHeight)) *
        (geometry.height - viewportHeight),
    );

  const navigate = (items: MinimapMarker[]) => {
    const ordered = [...items].sort(
      (a, b) => a.from - b.from || a.id.localeCompare(b.id),
    );
    const from = Math.max(0, Math.min(ordered[0].from, view.state.doc.length));
    onNavigateMarkers(ordered);
    view.dispatch({
      selection: { anchor: from },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
  };
  const jumpToLine = (line: number) => {
    const target = view.state.doc.line(
      Math.max(1, Math.min(Math.round(line), view.state.doc.lines)),
    );
    view.dispatch({
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
  };
  const scrollFromPointer = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragging.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const top = Math.max(
      0,
      Math.min(drag.travel, event.clientY - drag.top - drag.offset),
    );
    drag.handleTop = top;
    view.scrollDOM.scrollTo({
      top: drag.travel > 0 ? (top / drag.travel) * drag.maxScroll : 0,
      behavior: "instant",
    });
    // Keep the handle attached to the pointer while CodeMirror measures its viewport.
    if (viewportRef.current) viewportRef.current.style.top = `${top}px`;
  };
  const navigateWithKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    const center = (geometry.first + geometry.last) / 2;
    const step = Math.max(1, geometry.last - geometry.first);
    const line =
      event.key === "Home"
        ? 1
        : event.key === "End"
          ? lineCount
          : event.key === "ArrowUp"
            ? center - 1
            : event.key === "ArrowDown"
              ? center + 1
              : event.key === "PageUp"
                ? center - step
                : event.key === "PageDown"
                  ? center + step
                  : null;
    if (line !== null) {
      event.preventDefault();
      jumpToLine(line);
    }
  };

  return (
    <aside
      className="editor-minimap"
      aria-label="Document minimap"
      data-editor-minimap="true"
      style={{ backgroundColor: geometry.background }}
    >
      <DropdownMenu key={isReview ? "review" : "editing"}>
        <DropdownMenuTrigger asChild disabled={isReview}>
          <button
            type="button"
            className="editor-minimap-settings"
            aria-label="Minimap layers"
            data-filtered={isFiltered}
            disabled={isReview}
            title={
              isReview
                ? "Review markers are always shown"
                : isFiltered
                  ? "Minimap layers — filtering active"
                  : "Minimap layers"
            }
          >
            <ListFilterIcon aria-hidden="true" size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="left" align="start" sideOffset={8}>
          <DropdownMenuLabel>Minimap layers</DropdownMenuLabel>
          {layerGroups.map((group) => (
            <DropdownMenuCheckboxItem
              key={group.label}
              checked={
                group.layers.every((layer) => layers[layer])
                  ? true
                  : group.layers.some((layer) => layers[layer])
                    ? "indeterminate"
                    : false
              }
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => {
                for (const layer of group.layers) setLayer(layer, checked);
              }}
            >
              {group.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div
        ref={trackRef}
        className="editor-minimap-track"
        data-minimap-track="true"
      >
        <button
          type="button"
          className="editor-minimap-scrubber"
          aria-label={`Navigate document, visible lines ${geometry.first} to ${geometry.last} of ${lineCount}`}
          onKeyDown={navigateWithKeys}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const rect = trackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const scroller = view.scrollDOM;
            const height = Math.min(
              rect.height,
              Math.max(
                12,
                (rect.height * scroller.clientHeight) /
                  Math.max(1, scroller.scrollHeight),
              ),
            );
            const travel = rect.height - height;
            const maxScroll = Math.max(
              0,
              scroller.scrollHeight - scroller.clientHeight,
            );
            const top =
              maxScroll > 0 ? (travel * scroller.scrollTop) / maxScroll : 0;
            const pointer = event.clientY - rect.top;
            const inside = pointer >= top && pointer <= top + height;
            dragging.current = {
              pointerId: event.pointerId,
              offset: inside ? pointer - top : height / 2,
              top: rect.top,
              travel,
              maxScroll,
              handleTop: top,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            if (!inside) scrollFromPointer(event);
          }}
          onPointerMove={(event) => {
            scrollFromPointer(event);
          }}
          onPointerUp={(event) => {
            scrollFromPointer(event);
            dragging.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = null;
          }}
          onLostPointerCapture={() => {
            dragging.current = null;
          }}
        />
        <span
          ref={viewportRef}
          className="editor-minimap-viewport"
          data-minimap-viewport="true"
          aria-hidden="true"
          style={{ top: viewportTop, height: viewportHeight }}
        />
        {clusters.map((cluster, index) => (
          <MinimapMark
            key={cluster.id}
            cluster={cluster}
            tabIndex={cluster.id === activeId ? 0 : -1}
            onFocus={() => setFocusedId(cluster.id)}
            onNavigate={navigate}
            onMoveFocus={(direction) => {
              const next =
                direction === -Infinity
                  ? 0
                  : direction === Infinity
                    ? clusters.length - 1
                    : (index + direction + clusters.length) % clusters.length;
              trackRef.current
                ?.querySelectorAll<HTMLButtonElement>("[data-minimap-marker]")
                [next]?.focus();
            }}
          />
        ))}
      </div>
    </aside>
  );
}
