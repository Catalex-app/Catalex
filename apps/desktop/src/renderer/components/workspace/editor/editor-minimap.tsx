import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { DocumentMinimap } from "./document-minimap";
import { EditorView } from "@codemirror/view";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { useSettingsStore } from "@/stores/settings-store";
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
  const layers = useSettingsStore((state) => state.editorMinimapLayers);

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
  const lineCount = snapshot.doc.lines;
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
    <DocumentMinimap
      trackRef={trackRef}
      scrollElement={view.scrollDOM}
      geometry={geometry}
      clusters={clusters}
      layerGroups={layerGroups}
      isReview={isReview}
      navigationLabel={`Navigate document, visible lines ${geometry.first} to ${geometry.last} of ${lineCount}`}
      onKeyDown={navigateWithKeys}
      onNavigate={navigate}
    />
  );
}
