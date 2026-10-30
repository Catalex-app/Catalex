import { markdown } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { oneDark, oneDarkTheme } from "@codemirror/theme-one-dark";
import { EditorView, drawSelection } from "@codemirror/view";
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
    paddingRight: "4px",
    transition: "width 320ms ease-out, min-width 320ms ease-out",
  },
  ".dark & .cm-gutters": {
    backgroundColor: "color-mix(in oklab, var(--muted) 50%, var(--background))",
    borderRight: "1px solid var(--border)",
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
  ".cm-content": {
    paddingLeft: "8px",
    paddingRight: "12px",
  },
});

/** Presentation shared by editable documents and isolated historical source. */
export function createEditorSurfaceExtensions(): Extension[] {
  return [
    EditorView.lineWrapping,
    modelBackedCopyExtension(),
    drawSelection(),
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
