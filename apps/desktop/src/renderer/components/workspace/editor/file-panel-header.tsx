import { DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { useEditorStatisticsOverflow } from "./use-editor-statistics-overflow";
import { Hint } from "@/components/ui/tooltip";
import { type ReactNode } from "react";
import { WorkspacePanelHeader } from "../workspace-panel";

const textFileLabels: Record<string, string> = {
  tex: "LaTeX",
  ltx: "LaTeX",
  latex: "LaTeX",
  bib: "BibTeX",
  bst: "BibTeX style",
  sty: "LaTeX package",
  cls: "LaTeX class",
  clo: "LaTeX class options",
  def: "TeX definitions",
  cfg: "Configuration",
  fd: "LaTeX font definitions",
  dtx: "Documented LaTeX source",
  ins: "LaTeX installer",
  bbx: "BibLaTeX bibliography style",
  cbx: "BibLaTeX citation style",
  lbx: "BibLaTeX localization",
  ist: "MakeIndex style",
  xdy: "Xindy style",
  md: "Markdown",
  markdown: "Markdown",
  txt: "Plain text",
  json: "JSON",
  jsonc: "JSON with comments",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  csv: "CSV",
  tsv: "TSV",
};

function textFileLabel(fileName?: string) {
  const name = fileName?.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "latexmkrc" || name === ".latexmkrc")
    return "Latexmk configuration";
  const extension = name.includes(".") ? name.split(".").pop()! : "";
  return Object.prototype.hasOwnProperty.call(textFileLabels, extension)
    ? textFileLabels[extension]
    : "Text editor";
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`;
  const unit = bytes < 1024 * 1024 ? 1024 : 1024 * 1024;
  return `${Number((bytes / unit).toFixed(1))} ${unit === 1024 ? "KB" : "MB"}`;
}

export function FilePanelHeader({
  fileName,
  fileSize,
  deleted = false,
  children,
  label = "File information",
  textEditor = false,
  wrapControls = false,
  textStatistics,
}: {
  fileName?: string;
  fileSize?: number;
  deleted?: boolean;
  children?: ReactNode;
  label?: string;
  textEditor?: boolean;
  wrapControls?: boolean;
  textStatistics?: {
    wordCount: number;
    characterCount: number;
    selectedWords: number;
    selectedCharacters: number;
  };
}) {
  const {
    headerRef,
    statisticsRef,
    otherControlsRef,
    overflow,
    otherControlsVisible,
    setActionsOpen,
  } = useEditorStatisticsOverflow();
  if (textEditor) {
    const typeLabel = textFileLabel(fileName);
    const selected = (textStatistics?.selectedCharacters ?? 0) > 0;
    const words = textStatistics
      ? `${selected ? `${textStatistics.selectedWords.toLocaleString()}/` : ""}${textStatistics.wordCount.toLocaleString()}`
      : "";
    const characters = textStatistics
      ? `${selected ? `${textStatistics.selectedCharacters.toLocaleString()}/` : ""}${textStatistics.characterCount.toLocaleString()}`
      : "";
    return (
      <WorkspacePanelHeader
        ref={headerRef}
        actionsLabel="Editor"
        data-testid="text-editor-toolbar"
        data-editor-statistics-overflow={overflow}
        hasTrailingContent={
          (!overflow && !!textStatistics) || otherControlsVisible
        }
        className="gap-2"
        onActionsOpenChange={setActionsOpen}
        overflowContent={
          overflow && textStatistics ? (
            <div data-editor-statistics-menu>
              <DropdownMenuLabel className="flex items-center justify-between gap-6 font-normal">
                <span className="text-muted-foreground">Words</span>
                <span className="tabular-nums">{words}</span>
              </DropdownMenuLabel>
              <DropdownMenuLabel className="flex items-center justify-between gap-6 font-normal">
                <span className="text-muted-foreground">Characters</span>
                <span className="tabular-nums">{characters}</span>
              </DropdownMenuLabel>
            </div>
          ) : undefined
        }
        trailingContent={
          <>
            <div
              ref={statisticsRef}
              data-testid="text-editor-statistics"
              role="group"
              aria-label={
                textStatistics
                  ? `${words} words, ${characters} characters${selected ? " selected" : ""}`
                  : undefined
              }
              aria-hidden={overflow || !textStatistics || undefined}
              style={
                overflow || !textStatistics
                  ? {
                      position: "absolute",
                      left: 0,
                      visibility: "hidden",
                      pointerEvents: "none",
                    }
                  : undefined
              }
              className="flex w-max shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums"
            >
              {textStatistics && (
                <>
                  <span data-testid="text-word-count">{words} words</span>
                  <span aria-hidden="true" className="text-muted-foreground/60">
                    ·
                  </span>
                  <span data-testid="text-character-count">
                    {characters} chars
                  </span>
                </>
              )}
            </div>
            <div ref={otherControlsRef} className="flex shrink-0 items-center">
              {children}
            </div>
          </>
        }
      >
        <div
          data-editor-type-label
          className="min-w-0 flex-1 truncate text-muted-foreground text-xs"
          title={typeLabel}
        >
          <span className="inline-block">{typeLabel}</span>
        </div>
      </WorkspacePanelHeader>
    );
  }
  const baseName = fileName?.split(/[\\/]/).pop() ?? "";
  const extension = baseName.split(".").pop();
  const fileType = fileName
    ? baseName.lastIndexOf(".") > 0 && extension
      ? `${extension.toUpperCase()} file`
      : "File"
    : null;
  return (
    <WorkspacePanelHeader
      trailingContent={
        children ? (
          <div
            className={
              wrapControls
                ? "flex min-w-0 flex-wrap items-center justify-end gap-1"
                : "flex items-center gap-1"
            }
          >
            {children}
          </div>
        ) : undefined
      }
      hasTrailingContent={!!children}
      as="header"
      role="toolbar"
      aria-label={label}
      className={
        wrapControls
          ? "h-auto min-h-12 flex-wrap gap-x-1 gap-y-1 py-1.5 [&>[data-panel-header-trailing]]:min-w-0 [&>[data-panel-header-trailing]]:max-w-full"
          : "gap-1"
      }
    >
      <Hint
        content={
          deleted
            ? "File deleted"
            : fileSize === undefined
              ? (fileType ?? undefined)
              : `${fileType ? `${fileType} · ` : ""}${fileSize.toLocaleString()} bytes`
        }
      >
        <span className="mr-auto min-w-0 truncate pr-2 text-muted-foreground text-xs">
          {fileType && `${fileType} · `}
          {deleted
            ? "Deleted"
            : fileSize === undefined
              ? "Size unavailable"
              : formatSize(fileSize)}
        </span>
      </Hint>
    </WorkspacePanelHeader>
  );
}
