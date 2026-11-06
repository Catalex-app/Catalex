import { Hint } from "@/components/ui/tooltip";
import { useEffect, useRef } from "react";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { FileTextIcon, LoaderCircleIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type { FileDiff } from "@/stores/history-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  createEditorColorSchemeExtensions,
  createEditorFontSizeTheme,
  createEditorLanguageExtension,
  createEditorSurfaceExtensions,
} from "./editor/editor-appearance";
import { WorkspacePanelHeader } from "./workspace-panel";
import "./history-snapshot-content.css";

interface HistorySnapshotContentProps {
  diff: FileDiff | null;
  content: string | null;
  path: string;
  loading: boolean;
  currentWorkspace?: boolean;
  /** Optional heading when this read-only surface is used outside history. */
  previewLabel?: string;
}

// Deleted chunks in a unified merge are DOM widgets. Bound their total size as
// well as the diff algorithm's work so switching snapshots stays responsive.
const MAX_DIFF_CHARACTERS = 300_000;

function SnapshotSource({
  content,
  original,
  path,
  label,
}: {
  content: string;
  original?: string;
  path: string;
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const editorColorScheme = useSettingsStore(
    (state) => state.editorColorScheme,
  );
  const editorFontSize = useSettingsStore((state) => state.editorFontSize);

  useEffect(() => {
    if (!containerRef.current) return;

    const extensions: Extension[] = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({
        "aria-label": label,
        "aria-readonly": "true",
        tabindex: "0",
      }),
      createEditorColorSchemeExtensions(
        editorColorScheme,
        resolvedTheme === "dark" ? "dark" : "light",
      ),
      createEditorFontSizeTheme(editorFontSize),
      lineNumbers(),
      createEditorSurfaceExtensions(),
      EditorView.theme(
        {
          "&.cm-focused": { outline: "none" },
          ".cm-changedLine, .cm-deletedChunk": {
            borderRadius: "0",
          },
          "&.cm-merge-b .cm-changedLine": {
            backgroundColor:
              "color-mix(in oklab, var(--chart-2) 11%, transparent)",
          },
          "&.cm-merge-b .cm-changedText": {
            background: "color-mix(in oklab, var(--chart-2) 21%, transparent)",
          },
          ".cm-deletedChunk": {
            backgroundColor:
              "color-mix(in oklab, var(--destructive) 9%, transparent)",
            padding: "0 12px",
          },
          "&.cm-merge-b .cm-deletedChunk .cm-deletedText": {
            background:
              "color-mix(in oklab, var(--destructive) 17%, transparent)",
          },
          ".cm-changeGutter": { width: "3px" },
          "&.cm-merge-b .cm-changedLineGutter": {
            backgroundColor: "var(--chart-2)",
          },
          "&.cm-merge-b .cm-deletedLineGutter": {
            backgroundColor: "var(--destructive)",
          },
        },
        { dark: resolvedTheme === "dark" },
      ),
    ];

    if (content.length < MAX_DIFF_CHARACTERS) {
      extensions.push(createEditorLanguageExtension(path));
    }

    if (original !== undefined) {
      extensions.push(
        unifiedMergeView({
          original,
          mergeControls: false,
          highlightChanges: true,
          gutter: true,
          syntaxHighlightDeletionsMaxLength: 8_000,
          diffConfig: { scanLimit: 500, timeout: 30 },
        }),
      );
    }

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({ doc: content, extensions }),
    });
    return () => view.destroy();
  }, [
    content,
    original,
    path,
    label,
    resolvedTheme,
    editorColorScheme,
    editorFontSize,
  ]);

  return <div className="history-snapshot-source" ref={containerRef} />;
}

function EmptySnapshot({
  path,
  currentWorkspace,
}: {
  path: string;
  currentWorkspace: boolean;
}) {
  return (
    <div className="history-snapshot-empty">
      <FileTextIcon aria-hidden="true" size={25} strokeWidth={1.25} />
      <p>
        {path
          ? currentWorkspace
            ? "File no longer in the current workspace"
            : "File absent from this snapshot"
          : "Select a file to review"}
      </p>
      <span>
        {path
          ? currentWorkspace
            ? "Choose another current file from the sidebar."
            : "This version of the project does not contain this text file."
          : currentWorkspace
            ? "Choose a current file from the project sidebar."
            : "Choose a recorded text file from the project sidebar."}
      </span>
    </div>
  );
}

export function HistorySnapshotContent({
  diff,
  content,
  path,
  loading,
  currentWorkspace = false,
  previewLabel,
}: HistorySnapshotContentProps) {
  const snapshotText = diff ? diff.new_content : content;
  const largeDiff =
    !!diff &&
    (diff.old_content?.length ?? 0) + (diff.new_content?.length ?? 0) >
      MAX_DIFF_CHARACTERS;
  const hasComparison = !!diff && !largeDiff;

  return (
    <div className="history-snapshot-content">
      <div className="history-snapshot-panes">
        <section
          className="history-snapshot-pane"
          aria-label={
            currentWorkspace ? "Current workspace review" : "Snapshot review"
          }
        >
          <WorkspacePanelHeader
            trailingContent={
              hasComparison &&
              !loading && (
                <div
                  className="history-snapshot-legend"
                  role="group"
                  aria-label="Diff legend"
                >
                  <span data-change="removed">− Latest</span>
                  <span data-change="added">+ Selected</span>
                </div>
              )
            }
            hasTrailingContent={hasComparison && !loading}
            role="toolbar"
            aria-label={
              previewLabel ??
              (currentWorkspace ? "Current text" : "Snapshot text")
            }
            className="gap-3 px-3"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-xs">
                {previewLabel ??
                  (currentWorkspace ? "Current text" : "Snapshot text")}
              </div>
              <Hint content={path}>
                <div className="truncate text-[10px] text-muted-foreground">
                  {previewLabel
                    ? "Preview"
                    : loading
                      ? currentWorkspace
                        ? "Loading current file…"
                        : "Loading snapshot…"
                      : diff
                        ? "Read-only · Compared with latest snapshot"
                        : currentWorkspace
                          ? "Read-only · Includes unsaved edits"
                          : "Read-only saved text"}
                </div>
              </Hint>
            </div>
          </WorkspacePanelHeader>
          {largeDiff && !loading && (
            <p className="history-snapshot-large-notice">
              Large file · showing snapshot text without a detailed comparison.
            </p>
          )}
          {loading ? (
            <div className="history-snapshot-empty" role="status">
              <LoaderCircleIcon
                className="animate-spin"
                aria-hidden="true"
                size={20}
              />
              <p>
                {previewLabel
                  ? "Loading preview…"
                  : currentWorkspace
                    ? "Loading current file…"
                    : "Loading snapshot…"}
              </p>
            </div>
          ) : hasComparison ? (
            <SnapshotSource
              content={diff.new_content ?? ""}
              original={diff.old_content ?? ""}
              path={path}
              label={`Changes from latest snapshot for ${path}`}
            />
          ) : snapshotText !== null ? (
            <SnapshotSource
              content={snapshotText}
              path={path}
              label={`${previewLabel ?? (currentWorkspace ? "Current text" : "Snapshot text")} for ${path}`}
            />
          ) : (
            <EmptySnapshot path={path} currentWorkspace={currentWorkspace} />
          )}
        </section>
      </div>
    </div>
  );
}
