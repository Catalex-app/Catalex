import { markdown } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { oneDark, oneDarkTheme } from "@codemirror/theme-one-dark";
import {
  Direction,
  EditorView,
  RectangleMarker,
  ViewPlugin,
  type ViewUpdate,
  drawSelection,
  layer,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { latex } from "codemirror-lang-latex";
import { isMarkdownPath } from "@/lib/markdown";
import type { EditorColorScheme } from "@/stores/settings-store";
import { bibtex } from "./lang-bibtex";
import { modelBackedCopyExtension } from "./editor-clipboard";

// Style modules remain mounted, so identical themes must reuse their definitions.
const editorSurfaceTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--foreground)",
    backgroundColor: "var(--background)",
    WebkitBackfaceVisibility: "hidden",
    backfaceVisibility: "hidden",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "monospace",
    scrollbarWidth: "thin",
    scrollbarColor:
      "color-mix(in oklch, var(--muted-foreground) 45%, transparent) transparent",
    WebkitTransform: "translateZ(0)",
    transform: "translateZ(0)",
  },
  ".cm-scroller::-webkit-scrollbar": {
    width: "6px",
    height: "6px",
    background: "transparent",
  },
  ".cm-scroller::-webkit-scrollbar-track": {
    background: "transparent",
  },
  ".cm-scroller::-webkit-scrollbar-track-piece": {
    background: "transparent",
  },
  ".cm-scroller::-webkit-scrollbar-corner": {
    background: "transparent",
  },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    border: "1px solid transparent",
    borderRadius: "999px",
    backgroundColor:
      "color-mix(in oklch, var(--muted-foreground) 45%, transparent)",
    backgroundClip: "content-box",
  },
  ".cm-scroller::-webkit-scrollbar-thumb:hover": {
    backgroundColor:
      "color-mix(in oklch, var(--muted-foreground) 70%, transparent)",
  },
  ".cm-gutters": {
    "--editor-change-bar-width": "4px",
    "--editor-change-bar-gap": "2px",
    paddingRight: "4px",
    transition: "width 320ms ease-out, min-width 320ms ease-out",
  },
  // CodeMirror registers the change gutters after the line numbers.
  ".cm-gutters > :is(.cm-gitChangeGutter, .cm-changeGutter)": {
    order: "-1",
    marginLeft: "4px",
    paddingLeft: "0",
    width: "var(--editor-change-bar-width)",
    minWidth: "var(--editor-change-bar-width)",
    marginRight: "var(--editor-change-bar-gap)",
  },
  // Merge widget markers and Git line markers share one visual lane.
  ".cm-gutters > .cm-gitChangeGutter ~ .cm-changeGutter": {
    marginLeft:
      "calc(0px - var(--editor-change-bar-width) - var(--editor-change-bar-gap))",
  },
  ".dark & .cm-gutters": {
    backgroundColor: "color-mix(in oklab, var(--muted) 50%, var(--background))",
    borderRight: "1px solid var(--border)",
  },
  ":root[data-ui-theme] &": {
    backgroundColor:
      "var(--workspace-editor-surface-fill, var(--workspace-content-fill))",
  },
  ":root[data-ui-theme] & .cm-gutters": {
    borderRightWidth: "0",
    backgroundColor: "transparent",
  },
  ".cm-lineNumbers": {
    transition: "width 320ms ease-out, min-width 320ms ease-out",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    paddingLeft: "8px",
    paddingRight: "4px",
    transition: "transform 320ms ease-out, opacity 180ms ease-out",
    willChange: "transform",
  },
  ":root[data-ui-theme] & .cm-lineNumbers .cm-gutterElement": {
    paddingLeft: "12px",
  },
  ".cm-content": {
    paddingLeft: "8px",
    paddingRight: "12px",
  },
  ":root[data-ui-theme] & .cm-content": {
    paddingLeft: "4px",
  },
  ":root[data-ui-theme] & .cm-selectionBackground": {
    borderRadius: "var(--radius-xs)",
  },
  ":root[data-ui-theme] & .cm-lineNumbers .cm-activeLineGutter": {
    color: "var(--foreground)",
  },
});

const deletedLine = ".cm-deletedLine";

function isDeletedText(node: Node) {
  return (node instanceof Element ? node : node.parentElement)?.closest(
    deletedLine,
  );
}

function selectionRows(
  view: EditorView,
  ranges: readonly Range[],
  includeDeleted = false,
): RectangleMarker[] {
  if (!ranges.length) return [];

  const document = view.dom.ownerDocument;
  const textRange = document.createRange();
  const scroll = view.scrollDOM;
  const bounds = scroll.getBoundingClientRect();
  const originX =
    (view.textDirection === Direction.LTR
      ? bounds.left
      : bounds.right - scroll.clientWidth * view.scaleX) -
    scroll.scrollLeft * view.scaleX;
  const originY = bounds.top - scroll.scrollTop * view.scaleY;
  const markers: RectangleMarker[] = [];

  for (const selected of ranges) {
    const root = selected.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const fragments: DOMRect[] = [];
    for (
      let node = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
      node;
      node = walker.nextNode()
    ) {
      if (!selected.intersectsNode(node)) continue;
      const element = node.parentElement;
      const widget = element?.closest('.cm-content [contenteditable="false"]');
      if (widget && !(includeDeleted && isDeletedText(node))) continue;
      const start = node === selected.startContainer ? selected.startOffset : 0;
      const end =
        node === selected.endContainer
          ? selected.endOffset
          : (node as Text).length;
      if (start >= end) continue;
      textRange.setStart(node, start);
      textRange.setEnd(node, end);
      for (const rect of textRange.getClientRects()) {
        if (rect.width && rect.height) fragments.push(rect);
      }
    }

    // Syntax spans can split a visual row. Join touching fragments while
    // preserving separate islands in bidirectional text.
    fragments.sort((a, b) => a.top - b.top || a.left - b.left);
    let row:
      | { left: number; right: number; top: number; bottom: number }
      | undefined;
    const paint = () => {
      if (!row) return;
      markers.push(
        new RectangleMarker(
          "cm-selectionBackground",
          row.left - originX,
          row.top - originY,
          row.right - row.left,
          row.bottom - row.top,
        ),
      );
    };
    for (const fragment of fragments) {
      if (
        row &&
        Math.abs(fragment.top - row.top) < 0.5 &&
        fragment.left <= row.right + 0.5 &&
        fragment.right >= row.left - 0.5
      ) {
        row.left = Math.min(row.left, fragment.left);
        row.right = Math.max(row.right, fragment.right);
        row.bottom = Math.max(row.bottom, fragment.bottom);
      } else {
        paint();
        row = fragment.toJSON();
      }
    }
    paint();
  }
  return markers;
}

// Draw selections per rendered text fragment while CodeMirror handles the
// caret and selection state.
const rowSelection = [
  layer({
    above: false,
    class: "cm-rowSelectionLayer",
    mount: (dom) => dom.classList.add("cm-selectionLayer"),
    update: (update) =>
      update.selectionSet || update.docChanged || update.viewportChanged,
    markers(view) {
      if (view.state.selection.ranges.every((range) => range.empty)) return [];
      const ranges: Range[] = [];
      for (const range of view.state.selection.ranges) {
        for (const visible of view.visibleRanges) {
          const from = Math.max(range.from, visible.from);
          const to = Math.min(range.to, visible.to);
          if (from >= to) continue;

          const start = view.domAtPos(from, 1);
          const end = view.domAtPos(to, -1);
          const selected = view.dom.ownerDocument.createRange();
          selected.setStart(start.node, start.offset);
          selected.setEnd(end.node, end.offset);
          if (!selected.collapsed) ranges.push(selected);
        }
      }
      return selectionRows(view, ranges);
    },
  }),
  EditorView.theme({
    ".cm-rowSelectionLayer": { display: "none" },
    ":root[data-ui-theme] & .cm-rowSelectionLayer": {
      display: "block",
    },
    ":root[data-ui-theme] & .cm-selectionLayer:not(.cm-rowSelectionLayer):not(.cm-diffSelectionLayer)":
      {
        visibility: "hidden",
      },
  }),
];

const unfocusedDarkSelection =
  ":root.dark[data-ui-theme] &:not(.cm-focused) > .cm-scroller > ";

export const editorSelectionTheme = EditorView.theme({
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "rgba(118, 186, 247, 0.44) !important",
  },
  "&:not(.cm-focused) > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
    {
      backgroundColor: "rgba(225, 227, 231, 0.55) !important",
    },
  [`${unfocusedDarkSelection}.cm-rowSelectionLayer .cm-selectionBackground, ${unfocusedDarkSelection}.cm-diffSelectionLayer .cm-selectionBackground`]:
    {
      backgroundColor: "rgba(225, 227, 231, 0.12) !important",
    },
});

// A deletion or ancestor widget has no positions in the editable document.
// Paint its native range using the same rectangles as a document selection.
const diffSelection = ViewPlugin.fromClass(
  class {
    readonly dom: HTMLElement;
    readonly owner: Document;

    constructor(readonly view: EditorView) {
      this.owner = view.dom.ownerDocument;
      this.dom = this.owner.createElement("div");
      this.dom.className = "cm-layer cm-selectionLayer cm-diffSelectionLayer";
      this.dom.setAttribute("aria-hidden", "true");
      view.scrollDOM.appendChild(this.dom);
      this.owner.addEventListener("selectionchange", this.schedule);
    }

    private schedule = () => {
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const selection = this.owner.getSelection();
          if (!selection?.rangeCount || selection.isCollapsed) return [];
          const range = selection.getRangeAt(0);
          const { startContainer, endContainer } = range;
          if (
            !view.contentDOM.contains(startContainer) ||
            !view.contentDOM.contains(endContainer) ||
            !(isDeletedText(startContainer) || isDeletedText(endContainer))
          )
            return [];
          return selectionRows(view, [range], true);
        },
        write: (markers, view) => {
          this.dom.style.transform = `scale(${1 / view.scaleX}, ${1 / view.scaleY})`;
          this.dom.replaceChildren(...markers.map((marker) => marker.draw()));
        },
      });
    };

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged)
        this.schedule();
    }

    destroy() {
      this.owner.removeEventListener("selectionchange", this.schedule);
      this.dom.remove();
    }
  },
);

const drawingDeletedSelection =
  ":root[data-ui-theme] & .cm-scroller:has(> .cm-diffSelectionLayer > *)";

const diffTheme = EditorView.theme({
  "&": {
    "--diff-original": "#ef4444",
    "--diff-proposed": "#22c55e",
  },
  "&.cm-gitConflictMerge": {
    "--diff-original": "#2563eb",
    "--diff-proposed": "#7c3aed",
  },
  "&.cm-historyDiff": {
    "--diff-original": "var(--destructive)",
    "--diff-proposed": "var(--chart-2)",
  },
  ".cm-deletedChunk, .cm-deletedLineGutter": {
    "--diff-color": "var(--diff-original)",
  },
  ".cm-changedLine, .cm-changedLineGutter": {
    "--diff-color": "var(--diff-proposed)",
  },
  ".cm-threeWayAncestor, .cm-threeWayAncestorGutter": {
    "--diff-color": "#94a3b8",
  },
  "&.cm-merge-b .cm-changedLine, .cm-deletedChunk, .cm-threeWayAncestorLine": {
    backgroundColor:
      "color-mix(in srgb, var(--diff-color) 12%, transparent) !important",
  },
  ".cm-deletedChunk": {
    paddingLeft: "6px",
    position: "relative",
  },
  "&.cm-merge-b .cm-changedLine .cm-changedText, &.cm-merge-b .cm-deletedChunk .cm-deletedText, .cm-threeWayAncestorText":
    {
      background: "color-mix(in srgb, var(--diff-color) 25%, transparent)",
      textDecorationLine: "underline",
      textDecorationColor:
        "color-mix(in srgb, var(--diff-color) 75%, transparent)",
      textDecorationThickness: "2px",
      textUnderlineOffset: "1px",
      borderRadius: "var(--radius-xs)",
      boxDecorationBreak: "clone",
      WebkitBoxDecorationBreak: "clone",
    },
  "&.cm-merge-b .cm-changeGutter .cm-changedLineGutter, &.cm-merge-b .cm-changeGutter .cm-deletedLineGutter":
    {
      background: "var(--diff-color) !important",
    },
  ".cm-changeGutter .cm-threeWayAncestorGutter": {
    background:
      "linear-gradient(to bottom, transparent 24px, var(--diff-color) 24px)",
  },
  ".cm-deletedLine": { userSelect: "text", WebkitUserSelect: "text" },
  ".cm-deletedLine::selection, .cm-deletedLine ::selection": {
    backgroundColor: "rgba(118, 186, 247, 0.44) !important",
  },
  ".cm-deletedLine::-moz-selection, .cm-deletedLine ::-moz-selection": {
    backgroundColor: "rgba(118, 186, 247, 0.44) !important",
  },
  ".cm-diffSelectionLayer": {
    display: "none",
    pointerEvents: "none",
    zIndex: -1,
  },
  ":root[data-ui-theme] & .cm-diffSelectionLayer": { display: "block" },
  [`${drawingDeletedSelection} > .cm-rowSelectionLayer`]: {
    visibility: "hidden",
  },
  [`${drawingDeletedSelection} .cm-deletedLine::selection, ${drawingDeletedSelection} .cm-deletedLine ::selection`]:
    {
      backgroundColor: "transparent !important",
    },
  [`${drawingDeletedSelection} .cm-deletedLine::-moz-selection, ${drawingDeletedSelection} .cm-deletedLine ::-moz-selection`]:
    {
      backgroundColor: "transparent !important",
    },
});

export const editorDiffExtensions = [diffTheme, diffSelection];

/** Presentation shared by editable documents and isolated historical source. */
export function createEditorSurfaceExtensions(): Extension[] {
  return [
    EditorView.lineWrapping,
    modelBackedCopyExtension(),
    drawSelection(),
    rowSelection,
    editorSurfaceTheme,
  ];
}

/** LaTeX linting belongs to the live editor controller, never a snapshot. */
export function createEditorLanguageExtension(
  path: string,
  fallbackToLatex = false,
): Extension {
  if (isMarkdownPath(path)) return markdown();
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "bib") return bibtex();
  if (
    fallbackToLatex ||
    ["tex", "sty", "cls", "ltx"].includes(extension ?? "")
  ) {
    return latex({ enableLinting: false });
  }
  return [];
}

const fontSizeThemes = new Map<number, Extension>();

export function createEditorFontSizeTheme(fontSize: number): Extension {
  const cached = fontSizeThemes.get(fontSize);
  if (cached) return cached;
  const extension = EditorView.theme({
    "&": {
      fontSize: `${fontSize}px`,
    },
  });
  fontSizeThemes.set(fontSize, extension);
  return extension;
}

export type EditorResolvedTheme = "light" | "dark";

interface EditorSyntaxPalette {
  atom: string;
  comment: string;
  invalid: string;
  keyword: string;
  link: string;
  macro: string;
  meta: string;
  number: string;
  operator: string;
  punctuation: string;
  string: string;
  typeName: string;
  variable: string;
}

const EDITOR_COLOR_SCHEME_PALETTES: Record<
  Exclude<EditorColorScheme, "default">,
  Record<EditorResolvedTheme, EditorSyntaxPalette>
> = {
  ocean: {
    light: {
      atom: "#0e7490",
      comment: "#64748b",
      invalid: "#dc2626",
      keyword: "#0369a1",
      link: "#0284c7",
      macro: "#7c3aed",
      meta: "#64748b",
      number: "#0891b2",
      operator: "#0f766e",
      punctuation: "#475569",
      string: "#047857",
      typeName: "#2563eb",
      variable: "#0f172a",
    },
    dark: {
      atom: "#67e8f9",
      comment: "#94a3b8",
      invalid: "#f87171",
      keyword: "#38bdf8",
      link: "#7dd3fc",
      macro: "#c4b5fd",
      meta: "#94a3b8",
      number: "#22d3ee",
      operator: "#5eead4",
      punctuation: "#cbd5e1",
      string: "#86efac",
      typeName: "#93c5fd",
      variable: "#e2e8f0",
    },
  },
  forest: {
    light: {
      atom: "#4d7c0f",
      comment: "#6b7280",
      invalid: "#dc2626",
      keyword: "#166534",
      link: "#15803d",
      macro: "#854d0e",
      meta: "#78716c",
      number: "#a16207",
      operator: "#0f766e",
      punctuation: "#57534e",
      string: "#047857",
      typeName: "#365314",
      variable: "#1c1917",
    },
    dark: {
      atom: "#bef264",
      comment: "#a8a29e",
      invalid: "#f87171",
      keyword: "#86efac",
      link: "#bbf7d0",
      macro: "#fde68a",
      meta: "#a8a29e",
      number: "#facc15",
      operator: "#99f6e4",
      punctuation: "#d6d3d1",
      string: "#6ee7b7",
      typeName: "#d9f99d",
      variable: "#f5f5f4",
    },
  },
  sunset: {
    light: {
      atom: "#ea580c",
      comment: "#78716c",
      invalid: "#dc2626",
      keyword: "#be123c",
      link: "#db2777",
      macro: "#9333ea",
      meta: "#78716c",
      number: "#c2410c",
      operator: "#b45309",
      punctuation: "#57534e",
      string: "#b45309",
      typeName: "#e11d48",
      variable: "#1c1917",
    },
    dark: {
      atom: "#fdba74",
      comment: "#a8a29e",
      invalid: "#f87171",
      keyword: "#fb7185",
      link: "#f9a8d4",
      macro: "#d8b4fe",
      meta: "#a8a29e",
      number: "#fb923c",
      operator: "#fcd34d",
      punctuation: "#e7e5e4",
      string: "#fbbf24",
      typeName: "#fda4af",
      variable: "#fafaf9",
    },
  },
  mono: {
    light: {
      atom: "#334155",
      comment: "#64748b",
      invalid: "#dc2626",
      keyword: "#111827",
      link: "#334155",
      macro: "#111827",
      meta: "#64748b",
      number: "#334155",
      operator: "#475569",
      punctuation: "#64748b",
      string: "#334155",
      typeName: "#111827",
      variable: "#111827",
    },
    dark: {
      atom: "#cbd5e1",
      comment: "#94a3b8",
      invalid: "#f87171",
      keyword: "#f8fafc",
      link: "#cbd5e1",
      macro: "#f8fafc",
      meta: "#94a3b8",
      number: "#cbd5e1",
      operator: "#cbd5e1",
      punctuation: "#94a3b8",
      string: "#cbd5e1",
      typeName: "#f8fafc",
      variable: "#f8fafc",
    },
  },
};

function createEditorSyntaxHighlightStyle(
  scheme: Exclude<EditorColorScheme, "default">,
  theme: EditorResolvedTheme,
) {
  const palette = EDITOR_COLOR_SCHEME_PALETTES[scheme][theme];
  return HighlightStyle.define([
    { tag: tags.keyword, color: palette.keyword, fontWeight: "600" },
    {
      tag: [tags.atom, tags.bool, tags.url, tags.labelName],
      color: palette.atom,
    },
    { tag: [tags.literal, tags.inserted, tags.number], color: palette.number },
    { tag: [tags.string, tags.deleted], color: palette.string },
    {
      tag: [tags.regexp, tags.escape, tags.special(tags.string)],
      color: palette.string,
    },
    {
      tag: [tags.variableName, tags.local(tags.variableName)],
      color: palette.variable,
    },
    {
      tag: [tags.typeName, tags.namespace, tags.className],
      color: palette.typeName,
    },
    {
      tag: [tags.macroName, tags.special(tags.variableName)],
      color: palette.macro,
      fontWeight: "600",
    },
    {
      tag: [tags.propertyName, tags.definition(tags.propertyName)],
      color: palette.variable,
    },
    { tag: tags.operator, color: palette.operator },
    { tag: tags.punctuation, color: palette.punctuation },
    { tag: tags.link, color: palette.link, textDecoration: "underline" },
    { tag: tags.meta, color: palette.meta },
    { tag: tags.comment, color: palette.comment, fontStyle: "italic" },
    { tag: tags.invalid, color: palette.invalid },
  ]);
}

const colorSchemeExtensions = new Map<string, Extension[]>();

export function createEditorColorSchemeExtensions(
  scheme: EditorColorScheme,
  theme: EditorResolvedTheme,
): Extension[] {
  const key = `${scheme}:${theme}`;
  const cached = colorSchemeExtensions.get(key);
  if (cached) return cached;
  const extension =
    scheme === "default"
      ? theme === "dark"
        ? [oneDark]
        : [syntaxHighlighting(defaultHighlightStyle)]
      : [
          ...(theme === "dark" ? [oneDarkTheme] : []),
          syntaxHighlighting(createEditorSyntaxHighlightStyle(scheme, theme)),
        ];
  colorSchemeExtensions.set(key, extension);
  return extension;
}
