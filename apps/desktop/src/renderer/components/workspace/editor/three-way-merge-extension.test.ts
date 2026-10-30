import { history, isolateHistory, redo, undo } from "@codemirror/commands";
import {
  acceptChunk,
  getChunks,
  getOriginalDoc,
  unifiedMergeView,
} from "@codemirror/merge";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMergeSegment } from "@/lib/agent-workspace";
import { retainEditorHistory, reviewDecisionHistory } from "./editor-history";
import {
  chooseThreeWayVersion,
  createThreeWayMergeExtension,
  getThreeWayRegions,
  getThreeWaySelections,
} from "./three-way-merge-extension";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});
const spacer = "\na\nb\nc\nd\ne\nf\ng\nh\n";
const conflict: AgentMergeSegment = {
  kind: "conflict",
  ancestor: "ten samples\n",
  current: "twenty samples\n",
  agent: "fifteen samples\n",
};
function makeView(
  segments: AgentMergeSegment[],
  original?: string,
  proposed?: string,
) {
  const current = segments
    .map((segment) =>
      segment.kind === "resolved" ? segment.content : segment.current,
    )
    .join("");
  const agent = segments
    .map((segment) =>
      segment.kind === "resolved" ? segment.content : segment.agent,
    )
    .join("");
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: proposed ?? agent,
      extensions: [
        history(),
        unifiedMergeView({ original: original ?? current }),
        reviewDecisionHistory,
        createThreeWayMergeExtension({
          segments,
          original: original ?? current,
          proposed: proposed ?? agent,
          palette: "agent",
        }),
      ],
    }),
  });
  views.push(view);
  return view;
}

describe("native three-way review", () => {
  it("rebases undo region snapshots through non-history document updates", () => {
    const view = makeView([{ kind: "resolved", content: spacer }, conflict]);
    chooseThreeWayVersion(view, "ancestor");
    view.dispatch({
      changes: { from: 0, insert: "refreshed context\n" },
      annotations: Transaction.addToHistory.of(false),
    });
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      `refreshed context\n${spacer}fifteen samples\n`,
    );
    const [region] = getThreeWayRegions(view.state);
    expect(region.fromB).toBe(`refreshed context\n${spacer}`.length);
    expect(region.toB).toBe(view.state.doc.length);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      `refreshed context\n${spacer}ten samples\n`,
    );
    expect(getThreeWayRegions(view.state)).toHaveLength(0);
  });

  it("highlights ancestor words changed by either head without adding a heading", () => {
    const view = makeView([
      {
        kind: "conflict",
        ancestor: "We evaluated 10 samples using manual inspection.\n",
        current: "We evaluated 20 samples using manual inspection.\n",
        agent: "We evaluated 15 samples using automated inspection.\n",
      },
    ]);
    const ancestor = view.dom.querySelector("[data-three-way-ancestor]")!;
    const highlighted = Array.from(
      ancestor.querySelectorAll(".cm-threeWayAncestorText"),
    )
      .map((node) => node.textContent)
      .join("");
    expect(highlighted).toContain("10");
    expect(highlighted).toContain("manual");
    expect(highlighted).not.toContain("samples");
    expect(ancestor.querySelector(".cm-threeWayAncestorLabel")).toBeNull();
    expect(
      ancestor.querySelector(".cm-threeWayAncestorLine")?.textContent,
    ).toBe("We evaluated 10 samples using manual inspection.");
  });

  it("updates ancestor word highlights when the visible proposal is edited", () => {
    const view = makeView([
      {
        kind: "conflict",
        ancestor: "ten samples\n",
        current: "ten samples\n",
        agent: "ten samples\n",
      },
    ]);
    expect(view.dom.querySelectorAll(".cm-threeWayAncestorText")).toHaveLength(
      0,
    );
    view.dispatch({ changes: { from: 4, to: 11, insert: "specimens" } });
    expect(
      view.dom.querySelector(".cm-threeWayAncestorText")?.textContent,
    ).toBe("amples");
  });

  it("seeds final positions once during atomic activation and stacked reconfiguration", () => {
    const compartment = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: "short original\n",
        extensions: [history(), compartment.of([])],
      }),
    });
    views.push(view);
    const prefix = "Shared project heading\n";
    const segments: AgentMergeSegment[] = [
      { kind: "resolved", content: prefix },
      conflict,
      { kind: "resolved", content: spacer },
      conflict,
    ];
    const original = `${prefix}twenty samples\n${spacer}twenty samples\n`;
    const proposed = `${prefix}fifteen samples\n${spacer}fifteen samples\n`;
    const activate = (
      regions?: ReturnType<typeof getThreeWayRegions>,
      selections?: ReturnType<typeof getThreeWaySelections>,
      nextOriginal = original,
      nextProposed = proposed,
    ) =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: nextProposed },
        effects: compartment.reconfigure([
          unifiedMergeView({ original: nextOriginal }),
          reviewDecisionHistory,
          createThreeWayMergeExtension({
            segments,
            original: nextOriginal,
            proposed: nextProposed,
            regions,
            selections,
            palette: "git",
          }),
        ]),
        annotations: Transaction.addToHistory.of(false),
      });
    activate();
    expect(getThreeWayRegions(view.state)[0].fromB).toBe(prefix.length);
    chooseThreeWayVersion(view, "current", 1);
    const cachedRegions = getThreeWayRegions(view.state);
    const cachedSelections = getThreeWaySelections(view.state);
    const cachedOriginal = getOriginalDoc(view.state).toString();
    const cachedProposed = view.state.doc.toString();
    // Same field remains installed, but the replacement review has fresh seeds.
    activate();
    expect(getThreeWayRegions(view.state)).toHaveLength(2);
    expect(getThreeWayRegions(view.state)[0].fromB).toBe(prefix.length);
    activate(cachedRegions, cachedSelections, cachedOriginal, cachedProposed);
    expect(getThreeWayRegions(view.state)).toEqual(cachedRegions);
    expect(getThreeWaySelections(view.state)).toEqual(cachedSelections);
    chooseThreeWayVersion(view, "current");
    expect(view.state.doc.toString()).toBe(original);
  });

  it("restores cached unresolved regions and decisions with their native undo history", () => {
    const segments: AgentMergeSegment[] = [
      conflict,
      { kind: "resolved", content: spacer },
      conflict,
    ];
    const view = makeView(segments);
    chooseThreeWayVersion(view, "current", 0);
    const original = getOriginalDoc(view.state).toString();
    const proposed = view.state.doc.toString();
    const regions = getThreeWayRegions(view.state);
    const selections = getThreeWaySelections(view.state);
    const retained = retainEditorHistory(view.state);
    view.setState(
      EditorState.create({
        doc: proposed,
        extensions: [
          retained,
          unifiedMergeView({ original }),
          reviewDecisionHistory,
          createThreeWayMergeExtension({
            segments,
            original,
            proposed,
            regions,
            selections,
            palette: "agent",
          }),
        ],
      }),
    );
    expect(
      getThreeWayRegions(view.state).map((region) => region.index),
    ).toEqual([2]);
    expect(getThreeWaySelections(view.state)).toEqual({ 0: "current" });
    expect(undo(view)).toBe(true);
    expect(getThreeWayRegions(view.state)).toHaveLength(2);
    expect(getThreeWaySelections(view.state)).toEqual({});
    expect(view.state.doc.toString()).toBe(
      `fifteen samples\n${spacer}fifteen samples\n`,
    );
    expect(getOriginalDoc(view.state).toString()).toBe(
      `twenty samples\n${spacer}twenty samples\n`,
    );
  });

  it.each([
    "ancestor",
    "current",
    "agent",
  ] as const)("chooses %s only within the conflict, leaving an ordinary diff pending", (version) => {
    const segments: AgentMergeSegment[] = [
      conflict,
      { kind: "resolved", content: `${spacer}new ending\n` },
    ];
    const view = makeView(segments, `twenty samples\n${spacer}old ending\n`);
    expect(getChunks(view.state)?.chunks).toHaveLength(2);
    expect(chooseThreeWayVersion(view, version, 0)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      `${conflict[version]}${spacer}new ending\n`,
    );
    expect(getOriginalDoc(view.state).toString()).toBe(
      `${conflict[version]}${spacer}old ending\n`,
    );
    expect(getChunks(view.state)?.chunks).toHaveLength(1);
    expect(getThreeWayRegions(view.state)).toHaveLength(0);
    expect(getThreeWaySelections(view.state)).toEqual({ 0: version });
  });

  it("undoes and redoes decisions and ancestor blocks alongside normal typing", () => {
    const view = makeView([
      conflict,
      { kind: "resolved", content: spacer },
      conflict,
    ]);
    const original = getOriginalDoc(view.state).toString();
    const proposed = view.state.doc.toString();
    chooseThreeWayVersion(view, "ancestor", 0);
    expect(
      getThreeWayRegions(view.state).map((region) => region.index),
    ).toEqual([2]);
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "manual ending" },
      annotations: isolateHistory.of("full"),
    });
    expect(undo(view)).toBe(true);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(proposed);
    expect(getOriginalDoc(view.state).toString()).toBe(original);
    expect(getThreeWayRegions(view.state)).toHaveLength(2);
    expect(getThreeWaySelections(view.state)).toEqual({});
    expect(
      document.querySelectorAll('[data-three-way-ancestor="true"]'),
    ).toHaveLength(2);
    expect(redo(view)).toBe(true);
    expect(getThreeWayRegions(view.state)).toHaveLength(1);
    expect(getThreeWaySelections(view.state)).toEqual({ 0: "ancestor" });
    expect(redo(view)).toBe(true);
    chooseThreeWayVersion(view, "current", 2);
    expect(view.state.doc.toString()).toBe(
      `ten samples\n${spacer}twenty samples\nmanual ending`,
    );
  });

  it("maps manual edits before a region on the main side without altering original coordinates", () => {
    const view = makeView([
      { kind: "resolved", content: `heading\n${spacer}` },
      conflict,
    ]);
    view.dispatch({ changes: { from: 0, insert: "manual introduction\n" } });
    const [region] = getThreeWayRegions(view.state);
    expect(region.fromB - region.fromA).toBe("manual introduction\n".length);
    chooseThreeWayVersion(view, "current");
    expect(view.state.doc.toString()).toBe(
      `manual introduction\nheading\n${spacer}twenty samples\n`,
    );
    expect(getOriginalDoc(view.state).toString()).toBe(
      `heading\n${spacer}twenty samples\n`,
    );
  });

  it("resolves absent versions and bulk decisions in one reversible transaction", () => {
    const segments: AgentMergeSegment[] = [
      {
        kind: "conflict",
        ancestor: "",
        current: "current addition\n",
        agent: "agent addition\n",
      },
      { kind: "resolved", content: spacer },
      {
        kind: "conflict",
        ancestor: "deleted line\n",
        current: "changed line\n",
        agent: "",
      },
    ];
    const view = makeView(segments);
    const proposed = view.state.doc.toString();
    chooseThreeWayVersion(view, "ancestor");
    expect(view.state.doc.toString()).toBe(`${spacer}deleted line\n`);
    expect(getOriginalDoc(view.state).toString()).toBe(
      view.state.doc.toString(),
    );
    expect(getThreeWayRegions(view.state)).toHaveLength(0);
    undo(view);
    expect(view.state.doc.toString()).toBe(proposed);
    expect(getThreeWayRegions(view.state)).toHaveLength(2);
    redo(view);
    expect(getThreeWaySelections(view.state)).toEqual({
      0: "ancestor",
      2: "ancestor",
    });
  });

  it("renders the ancestor with native region controls and accepts manual proposal edits", () => {
    const view = makeView([conflict]);
    const ancestor = view.dom.querySelector('[data-three-way-ancestor="true"]');
    expect(ancestor?.textContent).toContain("ten samples");
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: "manual replacement\n",
      },
    });
    const button = view.dom.querySelector<HTMLButtonElement>(
      '[aria-label="Accept"]',
    );
    button?.click();
    expect(view.state.doc.toString()).toBe("manual replacement\n");
    expect(getOriginalDoc(view.state).toString()).toBe("manual replacement\n");
  });

  it("keeps replacements at conflict boundaries inside the region", () => {
    const view = makeView([conflict]);
    view.dispatch({ changes: { from: 0, to: 7, insert: "hundreds of" } });
    chooseThreeWayVersion(view, "current");
    expect(view.state.doc.toString()).toBe("twenty samples\n");
    undo(view);
    expect(view.state.doc.toString()).toBe("hundreds of samples\n");
    chooseThreeWayVersion(view, "agent");
    expect(getOriginalDoc(view.state).toString()).toBe("hundreds of samples\n");
  });

  it("maps original ranges after accepting an unrelated native chunk", () => {
    const view = makeView(
      [
        { kind: "resolved", content: `longer new heading\n${spacer}` },
        conflict,
      ],
      `old\n${spacer}twenty samples\n`,
    );
    acceptChunk(view, 0);
    const [region] = getThreeWayRegions(view.state);
    expect(region.fromA).toBe(region.fromB);
    chooseThreeWayVersion(view, "ancestor");
    expect(view.state.doc.toString()).toBe(
      `longer new heading\n${spacer}ten samples\n`,
    );
    expect(getOriginalDoc(view.state).toString()).toBe(
      view.state.doc.toString(),
    );
    undo(view);
    undo(view);
    expect(getOriginalDoc(view.state).toString()).toBe(
      `old\n${spacer}twenty samples\n`,
    );
    expect(getThreeWayRegions(view.state)[0].fromA).toBe(
      `old\n${spacer}`.length,
    );
  });
});
