import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import { computeGitLineChanges } from "./git-line-changes";
import {
  buildMinimapMarkers,
  clusterMinimapMarkers,
  DEFAULT_MINIMAP_LAYERS,
  normalizeMinimapLayers,
} from "./editor-minimap-model";

const doc = (value: string) => EditorState.create({ doc: value }).doc;

describe("editor minimap", () => {
  it("locates additions, replacements and deletions including the end of a file", () => {
    const before = "first\nsecond\nthird\nfourth\nfifth\nsixth\nlast";
    const after = "first\nadded\nsecond\nreplaced\nfourth\nsixth";
    const markers = buildMinimapMarkers(
      doc(after),
      computeGitLineChanges(before, after),
      [],
      [],
    );
    expect(markers.map(({ kind, line }) => ({ kind, line }))).toEqual([
      { kind: "add", line: 2 },
      { kind: "modify", line: 4 },
      { kind: "delete", line: 6 },
    ]);
    expect(markers.every((marker) => marker.from <= after.length)).toBe(true);
    const empty = buildMinimapMarkers(
      doc(""),
      computeGitLineChanges("removed", ""),
      [],
      [],
    );
    expect(empty[0].from).toBe(0);
  });

  it("keeps pure review deletions navigable and avoids duplicate Git markers", () => {
    const original = doc("first\nremoved\nlast");
    const current = doc("first\nlast");
    const chunks = Chunk.build(original, current);
    const markers = buildMinimapMarkers(
      current,
      computeGitLineChanges(original.toString(), current.toString()),
      [],
      [],
      { chunks, original },
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      kind: "review",
      line: 2,
      from: 6,
      title: "Pending deletion",
      before: "removed",
    });
    expect(
      buildMinimapMarkers(current, [], [], [], {
        chunks: [],
        original: current,
      }),
    ).toEqual([]);
  });

  it("uses live comment anchors, skips resolved comments and unlocated diagnostics", () => {
    const text = doc("one\ntwo\nthree");
    const markers = buildMinimapMarkers(
      text,
      [],
      [
        { id: "human", from: 4, to: 7, line: 999, text: "Check this" },
        {
          id: "agent",
          from: 8,
          to: 13,
          line: 999,
          text: "Revised",
          origin: { provider: "codex", sessionId: "session" },
        },
        {
          id: "resolved",
          from: 0,
          to: 3,
          line: 1,
          text: "Done",
          resolved: true,
        },
      ],
      [
        {
          from: null,
          to: null,
          line: null,
          severity: "error",
          message: "No location",
        },
        { from: 4, to: 7, line: 2, severity: "warning", message: "Located" },
      ],
    );
    expect(markers.map(({ kind, line }) => ({ kind, line }))).toEqual([
      { kind: "human", line: 2 },
      { kind: "warning", line: 2 },
      { kind: "agent", line: 3 },
    ]);
  });

  it("previews deleted text without striking out the unchanged line a review chunk includes", () => {
    const original = doc(
      "Paragraph 850. A sentence.\nParagraph 851. A sentence.",
    );
    const current = doc("Paragraph 851. A sentence.");
    const markers = buildMinimapMarkers(current, [], [], [], {
      chunks: Chunk.build(original, current),
      original,
    });
    expect(markers[0]).toMatchObject({
      kind: "review",
      before: "Paragraph 850. A sentence.",
    });
    const git = buildMinimapMarkers(
      current,
      computeGitLineChanges(original.toString(), current.toString()),
      [],
      [],
    );
    expect(git[0].before).toBe("Paragraph 850. A sentence.");
  });

  it("shows only review markers and keeps them visible when layers are disabled", () => {
    const original = doc("old\nkeep");
    const current = doc("new\nkeep");
    for (const conflict of [false, true]) {
      const markers = buildMinimapMarkers(
        current,
        [{ line: 2, kind: "add" }],
        [{ id: "human", from: 0, to: 3, line: 1, text: "Check" }],
        [{ from: 0, to: 3, line: 1, severity: "error", message: "Error" }],
        { chunks: Chunk.build(original, current), original, conflict },
      );
      expect(markers).toHaveLength(1);
      expect(markers[0].kind).toBe(conflict ? "conflict" : "review");
      expect(
        clusterMinimapMarkers(markers, 2, 200, {
          changes: false,
          human: false,
          agent: false,
          errors: false,
          warnings: false,
        }),
      ).toHaveLength(1);
    }
  });

  it("groups overlapping categories into a shared target without dropping members", () => {
    const text = doc(Array.from({ length: 1000 }, () => "line").join("\n"));
    const markers = buildMinimapMarkers(
      text,
      [{ line: 100, kind: "delete" }],
      Array.from({ length: 100 }, (_, i) => ({
        id: `comment-${i}`,
        from: text.line(100 + i).from,
        to: text.line(100 + i).to,
        line: 100 + i,
        text: "Comment",
      })),
      [
        {
          from: text.line(100).from,
          to: text.line(100).to,
          line: 100,
          severity: "error",
          message: "Error",
        },
      ],
    );
    const clusters = clusterMinimapMarkers(
      markers,
      text.lines,
      400,
      DEFAULT_MINIMAP_LAYERS,
    );
    expect(clusters.flatMap((cluster) => cluster.markers)).toHaveLength(102);
    expect(clusters[0].markers.map((marker) => marker.kind)).toEqual(
      expect.arrayContaining(["delete", "human", "error"]),
    );
    expect(clusters.length).toBeLessThan(10);
    const filtered = clusterMinimapMarkers(markers, text.lines, 400, {
      ...DEFAULT_MINIMAP_LAYERS,
      human: false,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].markers.map((marker) => marker.kind).sort()).toEqual([
      "delete",
      "error",
    ]);
    expect(
      clusters.every(
        (cluster) => cluster.top >= 0 && cluster.top + cluster.height <= 400,
      ),
    ).toBe(true);
  });

  it("restores layer preferences with defaults for missing or invalid values", () => {
    expect(normalizeMinimapLayers({ human: false })).toEqual({
      ...DEFAULT_MINIMAP_LAYERS,
      human: false,
    });
    expect(normalizeMinimapLayers({ changes: "false" } as never).changes).toBe(
      true,
    );
    expect(normalizeMinimapLayers(undefined)).toEqual(DEFAULT_MINIMAP_LAYERS);
  });
});

describe("review version stacks", () => {
  it.each([
    ["first\nlast", "first\nadded\nlast", ["proposed"]],
    ["first\nremoved\nlast", "first\nlast", ["current"]],
    ["first\nold\nlast", "first\nnew\nlast", ["current", "proposed"]],
  ])("uses actual two-way changes for %s → %s", (before, after, versions) => {
    const original = doc(before as string);
    const proposed = doc(after as string);
    const markers = buildMinimapMarkers(proposed, [], [], [], {
      chunks: Chunk.build(original, proposed),
      original,
    });
    expect(markers).toHaveLength(1);
    expect(markers[0].reviewVersions).toEqual(versions);
  });

  it.each([
    ["", "ours\n", "theirs\n", ["current", "proposed"]],
    ["base\n", "", "theirs\n", ["ancestor", "proposed"]],
    ["base\n", "ours\n", "", ["ancestor", "current"]],
    ["base\n", "ours\n", "theirs\n", ["ancestor", "current", "proposed"]],
    ["base\n", "same\n", "same\n", ["ancestor", "current", "proposed"]],
  ])("preserves present versions including conflicts without a native diff", (ancestor, current, agent, versions) => {
    const original = doc(current as string);
    const proposed = doc(agent as string);
    const markers = buildMinimapMarkers(proposed, [], [], [], {
      chunks: Chunk.build(original, proposed),
      original,
      regions: [
        {
          index: 0,
          fromA: 0,
          toA: original.length,
          fromB: 0,
          toB: proposed.length,
          ancestor: ancestor as string,
          current: current as string,
          agent: agent as string,
          palette: "agent",
        },
      ],
    });
    expect(markers).toHaveLength(1);
    expect(markers[0].reviewVersions).toEqual(versions);
  });
});
