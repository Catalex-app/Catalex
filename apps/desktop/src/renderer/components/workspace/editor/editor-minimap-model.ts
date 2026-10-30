import type { Text } from "@codemirror/state";
import type { ThreeWayRegion } from "./three-way-merge-extension";
import type { Chunk } from "@codemirror/merge";
import { computeLineDiffOps, type GitLineChange } from "./git-line-changes";
import { commentLabel, type InlineEditorComment } from "./inline-comments";
import type { DiagnosticItem } from "./problems-panel";

export type MinimapLayer =
  | "changes"
  | "human"
  | "agent"
  | "errors"
  | "warnings";
export type MinimapLayers = Record<MinimapLayer, boolean>;
export type MinimapKind =
  | "add"
  | "modify"
  | "delete"
  | "human"
  | "agent"
  | "error"
  | "warning"
  | "review"
  | "conflict";

export const DEFAULT_MINIMAP_LAYERS: MinimapLayers = {
  changes: true,
  human: true,
  agent: true,
  errors: true,
  warnings: true,
};

export function normalizeMinimapLayers(
  value: Partial<MinimapLayers> | undefined,
): MinimapLayers {
  return Object.fromEntries(
    Object.entries(DEFAULT_MINIMAP_LAYERS).map(([key, fallback]) => [
      key,
      typeof value?.[key as MinimapLayer] === "boolean"
        ? value[key as MinimapLayer]
        : fallback,
    ]),
  ) as MinimapLayers;
}

export type MinimapReviewVersion = "ancestor" | "current" | "proposed";

export interface MinimapMarker {
  id: string;
  layer: MinimapLayer;
  kind: MinimapKind;
  line: number;
  endLine: number;
  from: number;
  title: string;
  detail: string;
  before?: string;
  reviewVersions?: MinimapReviewVersion[];
  commentId?: string;
  diagnosticIndex?: number;
}

export interface MinimapReview {
  chunks: readonly Chunk[];
  original: Text;
  conflict?: boolean;
  regions?: readonly ThreeWayRegion[];
}

const snippet = (text: string) => text.trim().slice(0, 260);
const clampPosition = (doc: Text, position: number) =>
  Math.max(0, Math.min(position, doc.length));

export function buildMinimapMarkers(
  doc: Text,
  gitChanges: readonly GitLineChange[],
  comments: readonly InlineEditorComment[],
  diagnostics: readonly DiagnosticItem[],
  review?: MinimapReview,
): MinimapMarker[] {
  const markers: MinimapMarker[] = [];
  let region: MinimapMarker | undefined;
  for (const change of review ? [] : gitChanges) {
    if (change.line < 1 || change.line > doc.lines) continue;
    const from = doc.line(change.line).from;
    if (
      region?.kind === change.kind &&
      region.endLine + 1 === change.line &&
      change.kind !== "delete"
    ) {
      region.endLine = change.line;
      if (change.removedText)
        region.before = snippet(
          [region.before, change.removedText].filter(Boolean).join("\n"),
        );
    } else {
      region = {
        id: `git:${change.line}:${change.kind}`,
        layer: "changes",
        kind: change.kind,
        line: change.line,
        endLine: change.line,
        from,
        title:
          change.kind === "add"
            ? "Added lines"
            : change.kind === "delete"
              ? "Deleted lines"
              : "Modified lines",
        detail:
          change.kind === "delete"
            ? "Text was deleted near this line."
            : snippet(doc.line(change.line).text),
        before: change.removedText ? snippet(change.removedText) : undefined,
      };
      markers.push(region);
    }
  }

  // Group native chunks with their overlapping three-way regions. CodeMirror
  // can split one Git region into several chunks, or absorb adjacent clean edits.
  // One marker covers that connected range without dropping either kind of edit.
  const groups: {
    fromA: number;
    toA: number;
    fromB: number;
    toB: number;
    chunks: Chunk[];
    regions: ThreeWayRegion[];
  }[] = (review?.regions ?? []).map((region) => ({
    ...region,
    chunks: [],
    regions: [region],
  }));
  const overlaps = (from: number, to: number, start: number, end: number) =>
    from === to
      ? start <= from && end >= from
      : start === end
        ? from <= start && to >= start
        : from < end && start < to;
  for (const chunk of review?.chunks ?? []) {
    const matching = groups.filter(
      (group) =>
        overlaps(group.fromB, group.toB, chunk.fromB, chunk.toB) ||
        overlaps(group.fromA, group.toA, chunk.fromA, chunk.toA),
    );
    const group = {
      fromA: chunk.fromA,
      toA: chunk.toA,
      fromB: chunk.fromB,
      toB: chunk.toB,
      chunks: [chunk],
      regions: [] as ThreeWayRegion[],
    };
    for (const match of matching) {
      group.fromA = Math.min(group.fromA, match.fromA);
      group.toA = Math.max(group.toA, match.toA);
      group.fromB = Math.min(group.fromB, match.fromB);
      group.toB = Math.max(group.toB, match.toB);
      group.chunks.push(...match.chunks);
      group.regions.push(...match.regions);
      groups.splice(groups.indexOf(match), 1);
    }
    groups.push(group);
  }
  for (const group of groups.sort((a, b) => a.fromB - b.fromB)) {
    const from = clampPosition(doc, group.fromB);
    const operations = group.chunks.flatMap((chunk) => {
      const before = review!.original.sliceString(chunk.fromA, chunk.endA);
      const after = doc.sliceString(
        clampPosition(doc, chunk.fromB),
        clampPosition(doc, chunk.endB),
      );
      // Presentable diffs may absorb unchanged context. Classify actual edits.
      return computeLineDiffOps(
        before ? before.split("\n") : [],
        after ? after.split("\n") : [],
      );
    });
    const added = operations.filter((op) => op.type === "add");
    const deleted = operations.filter((op) => op.type === "del");
    const kind =
      added.length === 0 ? "delete" : deleted.length === 0 ? "add" : "modify";
    const versions: MinimapReviewVersion[] = [];
    if (group.regions.some((region) => region.ancestor.length > 0))
      versions.push("ancestor");
    if (
      deleted.length ||
      group.regions.some((region) => region.current.length > 0)
    )
      versions.push("current");
    if (
      added.length ||
      group.regions.some((region) => region.toB > region.fromB)
    )
      versions.push("proposed");
    markers.push({
      id: `review:${group.fromA}:${group.fromB}`,
      layer: "changes",
      kind: review?.conflict ? "conflict" : "review",
      reviewVersions: versions,
      from,
      line: doc.lineAt(from).number,
      endLine: doc.lineAt(Math.max(from, clampPosition(doc, group.toB - 1)))
        .number,
      title:
        group.regions.length || review?.conflict
          ? "Unresolved conflict"
          : kind === "add"
            ? "Pending addition"
            : kind === "delete"
              ? "Pending deletion"
              : "Pending change",
      detail:
        kind === "delete"
          ? "Text was deleted near this line."
          : snippet(added.map((op) => op.text).join("\n")),
      before: snippet(deleted.map((op) => op.text).join("\n")),
    });
  }

  if (review) return markers;

  for (const comment of comments) {
    if (comment.resolved) continue;
    const from = clampPosition(doc, comment.from);
    const kind = comment.origin ? "agent" : "human";
    markers.push({
      id: `comment:${comment.id}`,
      layer: kind,
      kind,
      from,
      line: doc.lineAt(from).number,
      endLine: doc.lineAt(clampPosition(doc, Math.max(from, comment.to - 1)))
        .number,
      title: `Comment ${commentLabel(comment)}`,
      detail: snippet(comment.text || comment.draftText || "Unsaved comment"),
      commentId: comment.id,
    });
  }

  diagnostics.forEach((diagnostic, index) => {
    // Unlocated compiler messages stay in Problems; do not invent a map position.
    if (
      diagnostic.from === null ||
      !["error", "warning"].includes(diagnostic.severity)
    )
      return;
    const from = clampPosition(doc, diagnostic.from);
    const kind = diagnostic.severity as "error" | "warning";
    markers.push({
      id: `diagnostic:${index}:${from}`,
      diagnosticIndex: index,
      layer: kind === "error" ? "errors" : "warnings",
      kind,
      from,
      line: doc.lineAt(from).number,
      endLine: doc.lineAt(
        clampPosition(doc, Math.max(from, (diagnostic.to ?? from) - 1)),
      ).number,
      title: kind === "error" ? "Error" : "Warning",
      detail: diagnostic.message,
    });
  });
  return markers.sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
}

export function minimapLane(marker: MinimapMarker): number {
  return marker.layer === "changes"
    ? 0
    : marker.kind === "human" || marker.kind === "agent"
      ? 1
      : 2;
}

export interface MinimapCluster {
  id: string;
  lane: number;
  top: number;
  height: number;
  markers: MinimapMarker[];
}

/** Merge hit targets that would overlap, keeping every member navigable. */
export function clusterMinimapMarkers(
  markers: readonly MinimapMarker[],
  lines: number,
  height: number,
  layers: MinimapLayers,
  positions?: ReadonlyMap<string, { top: number; bottom: number }>,
): MinimapCluster[] {
  const clusters: MinimapCluster[] = [];

  const available = Math.max(1, height - 20);
  for (const marker of markers) {
    if (
      marker.kind !== "review" &&
      marker.kind !== "conflict" &&
      !layers[marker.layer]
    )
      continue;
    const lane = minimapLane(marker);
    const measured = positions?.get(marker.id);
    const top = measured
      ? Math.max(0, Math.min(available, measured.top - 10))
      : ((marker.line - 1) / Math.max(1, lines - 1)) * available;
    const bottom = Math.min(
      height,
      top +
        Math.max(
          20,
          measured
            ? measured.bottom - measured.top
            : ((marker.endLine - marker.line) / Math.max(1, lines)) * available,
        ),
    );
    const previous = clusters[clusters.length - 1];
    if (previous && top < previous.top + previous.height + 2) {
      previous.height = Math.max(previous.height, bottom - previous.top);
      previous.markers.push(marker);
    } else {
      const cluster = {
        id: `${lane}:${marker.id}`,
        lane,
        top,
        height: bottom - top,
        markers: [marker],
      };
      clusters.push(cluster);
    }
  }
  return clusters.sort((a, b) => a.top - b.top || a.lane - b.lane);
}
