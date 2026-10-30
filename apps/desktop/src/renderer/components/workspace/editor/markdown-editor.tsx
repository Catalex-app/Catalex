import { spellCheckExtension } from "@/lib/spelling/extension";
import { createEditorFontSizeTheme } from "./editor-appearance";
import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { modelBackedCopyExtension } from "./editor-clipboard";

const markdownEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--foreground)",
    backgroundColor: "var(--background)",
  },
  ".cm-scroller": {
    overflow: "auto",
    scrollbarWidth: "thin",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "8px 12px",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--accent) 35%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklch, var(--accent) 45%, transparent)",
  },
  "&.cm-focused": {
    outline: "none",
  },
});

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}

export function MarkdownEditor({
  value,
  onChange,
  ariaLabel,
  className,
  disabled = false,
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const syncingValueRef = useRef(false);
  const { resolvedTheme } = useTheme();
  const editorFontSize = useSettingsStore((s) => s.editorFontSize);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) return;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      spellCheckExtension("document.md"),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      drawSelection(),
      modelBackedCopyExtension(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !syncingValueRef.current) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
      EditorState.readOnly.of(disabled),
      EditorView.editable.of(!disabled),
      EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
      markdownEditorTheme,
      createEditorFontSizeTheme(editorFontSize),
      resolvedTheme === "dark" ? oneDark : [],
    ];

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({ doc: value, extensions }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [ariaLabel, disabled, editorFontSize, resolvedTheme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    syncingValueRef.current = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
    syncingValueRef.current = false;
  }, [value]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-input bg-background shadow-xs",
        disabled && "opacity-50",
        className,
      )}
      ref={containerRef}
    />
  );
}
