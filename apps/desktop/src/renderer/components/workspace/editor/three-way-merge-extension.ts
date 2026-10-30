import { invertedEffects, isolateHistory } from "@codemirror/commands";
import {
  getChunks,
  getOriginalDoc,
  originalDocChangeEffect,
  presentableDiff,
  updateOriginalDoc,
} from "@codemirror/merge";
import {
  ChangeSet,
  type ChangeDesc,
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutterWidgetClass,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import type { AgentMergeSegment } from "@/lib/agent-workspace";
import { createDocumentChangeSet } from "./editor-history";
import {
  captureReviewViewport,
  restoreReviewViewport,
} from "./review-viewport";

export type ThreeWayVersion = "ancestor" | "current" | "agent";
export interface ThreeWayRegion {
  /** Stable index in the backend's merge segments. */
  index: number;
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
  ancestor: string;
  current: string;
  agent: string;
  palette: "agent" | "git";
}
interface ThreeWaySnapshot {
  regions: readonly ThreeWayRegion[];
  selections: Readonly<Record<number, ThreeWayVersion>>;
}
interface ThreeWayState extends ThreeWaySnapshot {
  decorations: DecorationSet;
}
const initialThreeWay = Facet.define<ThreeWaySnapshot, ThreeWaySnapshot>({
  combine: (values) => values[0] ?? { regions: [], selections: {} },
});

function mapRange(
  from: number,
  to: number,
  changes: ChangeDesc,
): [number, number] {
  // Boundary insertions belong to adjacent text. A replacement that includes a
  // boundary, however, is an edit inside this region and must remain selectable.
  let startAssociation = 1;
  let endAssociation = from === to ? 1 : -1;
  changes.iterChangedRanges((start, end) => {
    if (start <= from && end > from) startAssociation = -1;
    if (start < to && end >= to) endAssociation = 1;
  });
  const start = changes.mapPos(from, startAssociation);
  const end = changes.mapPos(to, endAssociation);
  return [Math.min(start, end), Math.max(start, end)];
}
function mapRegion(
  region: ThreeWayRegion,
  changes: ChangeDesc,
  side: "A" | "B",
): ThreeWayRegion {
  const [from, to] = mapRange(
    region[`from${side}`],
    region[`to${side}`],
    changes,
  );
  return { ...region, [`from${side}`]: from, [`to${side}`]: to };
}
const restoreThreeWay = StateEffect.define<
  ThreeWaySnapshot & { documentChanges: ChangeDesc }
>({
  map: (value, changes) => {
    if (changes.empty) return value;
    // History rebases effects using the document before the undo/redo change.
    // Region snapshots describe its result, so map through that change first.
    const resultingChanges = changes.mapDesc(value.documentChanges, true);
    return {
      ...value,
      regions: value.regions.map((region) =>
        mapRegion(region, resultingChanges, "B"),
      ),
      documentChanges: value.documentChanges.mapDesc(changes),
    };
  },
});

class AncestorWidget extends WidgetType {
  constructor(
    readonly region: ThreeWayRegion,
    readonly proposed: string,
  ) {
    super();
  }
  eq(other: AncestorWidget) {
    return (
      this.region.index === other.region.index &&
      this.region.ancestor === other.region.ancestor &&
      this.region.current === other.region.current &&
      this.proposed === other.proposed &&
      this.region.palette === other.region.palette
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-threeWayAncestor";
    root.dataset.threeWayAncestor = "true";
    root.dataset.threeWayIndex = String(this.region.index);
    root.dataset.threeWayPalette = this.region.palette;
    const buttons = root.appendChild(document.createElement("div"));
    buttons.className = "cm-chunkButtons";
    for (const [version, label] of [
      ["ancestor", "Use Ancestor"],
      ["current", "Reject"],
      ["agent", "Accept"],
    ] as const) {
      const button = buttons.appendChild(document.createElement("button"));
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", label);
      button.dataset.threeWayVersion = version;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const region = getThreeWayRegions(view.state).find(
          (region) => region.index === this.region.index,
        );
        if (!region) return;
        const viewport = captureReviewViewport(view, region.fromB);
        chooseThreeWayVersion(view, version, this.region.index);
        restoreReviewViewport(view, viewport);
      });
    }
    // Highlight ancestor text changed by either head, using the same
    // word-aligned diff algorithm as CodeMirror's native merge chunks.
    const text = this.region.ancestor.replace(/\r?\n$/, "");
    const changed = [this.region.current, this.proposed]
      .flatMap((head) =>
        presentableDiff(this.region.ancestor, head, {
          scanLimit: 10000,
          timeout: 250,
        }),
      )
      .filter((range) => range.fromA < range.toA)
      .sort((a, b) => a.fromA - b.fromA);
    let offset = 0;
    for (const line of text.split("\n")) {
      const content = root.appendChild(document.createElement("div"));
      content.className = "cm-deletedLine cm-threeWayAncestorLine";
      const end = offset + line.length;
      let position = offset;
      for (const range of changed) {
        const from = Math.max(position, range.fromA);
        const to = Math.min(end, range.toA);
        if (from >= to) continue;
        content.appendChild(
          document.createTextNode(text.slice(position, from)),
        );
        const mark = content.appendChild(document.createElement("span"));
        mark.className = "cm-threeWayAncestorText";
        mark.textContent = text.slice(from, to);
        position = to;
      }
      content.appendChild(document.createTextNode(text.slice(position, end)));
      if (!line) content.appendChild(document.createElement("br"));
      offset = end + 1;
    }
    return root;
  }
  ignoreEvent() {
    return true;
  }
}
function withDecorations(
  snapshot: ThreeWaySnapshot,
  document?: string,
): ThreeWayState {
  return {
    ...snapshot,
    decorations: Decoration.set(
      snapshot.regions.map((region) =>
        Decoration.widget({
          widget: new AncestorWidget(
            region,
            document?.slice(region.fromB, region.toB) ?? region.agent,
          ),
          block: true,
          side: -2,
        }).range(region.fromB),
      ),
      true,
    ),
  };
}
export const threeWayMergeField = StateField.define<ThreeWayState>({
  create: (state) => withDecorations(state.facet(initialThreeWay)),
  update(value, transaction) {
    // Activation replaces the document and configures merge extensions in the
    // same transaction. These seeds already describe its resulting document.
    // A new factory config also resets the field when a stacked review replaces
    // an existing review without first removing the field.
    if (
      !transaction.startState.field(threeWayMergeField, false) ||
      transaction.startState.facet(initialThreeWay) !==
        transaction.state.facet(initialThreeWay)
    ) {
      return withDecorations(
        transaction.state.facet(initialThreeWay),
        transaction.newDoc.toString(),
      );
    }
    let regions = value.regions.map((region) =>
      mapRegion(region, transaction.changes, "B"),
    );
    for (const effect of transaction.effects) {
      if (effect.is(updateOriginalDoc))
        regions = regions.map((region) =>
          mapRegion(region, effect.value.changes, "A"),
        );
    }
    const restored = transaction.effects.find((effect) =>
      effect.is(restoreThreeWay),
    );
    return withDecorations(
      restored?.value ?? { regions, selections: value.selections },
      transaction.newDoc.toString(),
    );
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

export function getThreeWayRegions(
  state: EditorState,
): readonly ThreeWayRegion[] {
  return state.field(threeWayMergeField, false)?.regions ?? [];
}
export function getThreeWaySelections(
  state: EditorState,
): Readonly<Record<number, ThreeWayVersion>> {
  return state.field(threeWayMergeField, false)?.selections ?? {};
}

/** Resolve one region, or all unresolved regions, without deciding unrelated changes. */
export function chooseThreeWayVersion(
  view: EditorView,
  version: ThreeWayVersion,
  index?: number,
): boolean {
  const value = view.state.field(threeWayMergeField, false);
  if (!value) return false;
  const chosen = value.regions.filter(
    (region) => index === undefined || region.index === index,
  );
  if (!chosen.length) return false;
  // Accept the visible proposal, including edits made during review, just like
  // native acceptChunk. The other choices explicitly restore stored versions.
  const content = (region: ThreeWayRegion) =>
    version === "agent"
      ? view.state.sliceDoc(region.fromB, region.toB)
      : region[version];
  const mainChanges = ChangeSet.of(
    chosen.map((region) => ({
      from: region.fromB,
      to: region.toB,
      insert: content(region),
    })),
    view.state.doc.length,
  );
  const originalChanges = ChangeSet.of(
    chosen.map((region) => ({
      from: region.fromA,
      to: region.toA,
      insert: content(region),
    })),
    getOriginalDoc(view.state).length,
  );
  const selected = new Set(chosen.map((region) => region.index));
  const regions = value.regions
    .filter((region) => !selected.has(region.index))
    .map((region) =>
      mapRegion(mapRegion(region, mainChanges, "B"), originalChanges, "A"),
    );
  const selections = { ...value.selections };
  for (const region of chosen) selections[region.index] = version;
  view.dispatch({
    changes: mainChanges,
    effects: [
      originalDocChangeEffect(view.state, originalChanges),
      restoreThreeWay.of({
        regions,
        selections,
        documentChanges: mainChanges.desc,
      }),
    ],
    annotations: isolateHistory.of("full"),
    userEvent: "accept.threeWay",
  });
  return true;
}

function overlaps(from: number, to: number, start: number, end: number) {
  return from === to ? start <= from && end >= from : start < to && end > from;
}
// Native deletion widgets may be reused by CodeMirror. Refresh their class after
// rendering, including when a choice changes only the original document.
const conflictButtons = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.schedule();
    }
    update() {
      this.schedule();
    }
    schedule() {
      this.view.requestMeasure({
        key: this,
        read: () => null,
        write: () => {
          const regions = getThreeWayRegions(this.view.state);
          const chunks = getChunks(this.view.state)?.chunks ?? [];
          for (const element of this.view.dom.querySelectorAll<HTMLElement>(
            ".cm-deletedChunk",
          )) {
            const position = this.view.posAtDOM(element);
            const chunk = chunks.find(
              (candidate) => candidate.fromB === position,
            );
            element.classList.toggle(
              "cm-threeWayConflictChunk",
              !!chunk &&
                regions.some(
                  (region) =>
                    overlaps(
                      region.fromB,
                      region.toB,
                      chunk.fromB,
                      chunk.toB,
                    ) ||
                    overlaps(region.fromA, region.toA, chunk.fromA, chunk.toA),
                ),
            );
          }
        },
      });
    }
  },
);
const ancestorGutterMarker = new (class extends GutterMarker {
  elementClass = "cm-threeWayAncestorGutter";
})();
const theme = EditorView.baseTheme({
  ".cm-changeGutter .cm-threeWayAncestorGutter": {
    background: "linear-gradient(to bottom, transparent 24px, #94a3b8 24px)",
  },
  ".cm-threeWayConflictChunk > .cm-chunkButtons": {
    display: "none !important",
  },
  ".cm-threeWayAncestor": {
    position: "relative",
    paddingLeft: "6px",
    paddingTop: "24px",
    color: "inherit",
  },
  ".cm-threeWayAncestor .cm-threeWayAncestorLine": {
    backgroundColor: "#f1f5f9 !important",
    marginLeft: "-6px",
    paddingLeft: "6px",
  },
  ".cm-threeWayAncestorText": {
    backgroundColor: "#cbd5e1 !important",
  },
  "&dark .cm-threeWayAncestor .cm-threeWayAncestorLine": {
    backgroundColor: "rgba(148, 163, 184, 0.12) !important",
  },
  "&dark .cm-threeWayAncestorText": {
    backgroundColor: "rgba(148, 163, 184, 0.28) !important",
  },
  ".cm-threeWayAncestor .cm-chunkButtons": { top: "2px", transform: "none" },
  ".cm-threeWayAncestor button": {
    backgroundColor: "#64748b",
    color: "white",
  },
  '.cm-threeWayAncestor[data-three-way-palette="agent"] button[data-three-way-version="current"]':
    { backgroundColor: "#ef4444" },
  '.cm-threeWayAncestor[data-three-way-palette="agent"] button[data-three-way-version="agent"]':
    { backgroundColor: "#36ad5e" },
  '.cm-threeWayAncestor[data-three-way-palette="git"] button[data-three-way-version="current"]':
    { backgroundColor: "#2563eb" },
  '.cm-threeWayAncestor[data-three-way-palette="git"] button[data-three-way-version="agent"]':
    { backgroundColor: "#7c3aed" },
});

export function createThreeWayMergeExtension(options: {
  segments: readonly AgentMergeSegment[];
  original: string;
  proposed: string;
  palette: "agent" | "git";
  regions?: readonly ThreeWayRegion[];
  selections?: Readonly<Record<number, ThreeWayVersion>>;
}): Extension {
  let regions = options.regions;
  if (!regions) {
    let original = "";
    let proposed = "";
    const initial: ThreeWayRegion[] = [];
    options.segments.forEach((segment, index) => {
      if (segment.kind === "resolved") {
        original += segment.content;
        proposed += segment.content;
      } else {
        initial.push({
          index,
          fromA: original.length,
          toA: original.length + segment.current.length,
          fromB: proposed.length,
          toB: proposed.length + segment.agent.length,
          ancestor: segment.ancestor,
          current: segment.current,
          agent: segment.agent,
          palette: options.palette,
        });
        original += segment.current;
        proposed += segment.agent;
      }
    });
    const originalMap = createDocumentChangeSet(original, options.original);
    const mainMap = createDocumentChangeSet(proposed, options.proposed);
    regions = initial.map((region) =>
      mapRegion(mapRegion(region, originalMap, "A"), mainMap, "B"),
    );
  }
  return [
    initialThreeWay.of({ regions, selections: options.selections ?? {} }),
    threeWayMergeField,
    invertedEffects.of((transaction) =>
      transaction.effects.some((effect) => effect.is(restoreThreeWay))
        ? [
            restoreThreeWay.of({
              regions: getThreeWayRegions(transaction.startState),
              selections: getThreeWaySelections(transaction.startState),
              documentChanges: transaction.changes.invertedDesc,
            }),
          ]
        : [],
    ),
    conflictButtons,
    gutterWidgetClass.of((_view, widget) =>
      widget instanceof AncestorWidget && widget.region.ancestor.length > 0
        ? ancestorGutterMarker
        : null,
    ),
    theme,
  ];
}
