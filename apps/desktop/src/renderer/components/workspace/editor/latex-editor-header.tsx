import { useEditorStatisticsOverflow } from "./use-editor-statistics-overflow";
import { WorkspacePanelHeader } from "../workspace-panel";
import { Hint } from "@/components/ui/tooltip";
import { memo, type ReactNode } from "react";
import { ResponsiveFormattingTools } from "./responsive-formatting-tools";
import {
  BoldIcon,
  ChevronDownIcon,
  Code2Icon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  SigmaIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type LatexInlineFormat =
  | "bold"
  | "italic"
  | "link"
  | "code"
  | "inline-math";

export type LatexBlockFormat =
  | "part"
  | "chapter"
  | "section"
  | "subsection"
  | "subsubsection"
  | "paragraph"
  | "subparagraph"
  | "quote"
  | "unordered-list"
  | "ordered-list";

interface LatexEditorHeaderProps {
  selectedWords: number;
  selectedCharacters: number;
  wordCount: number;
  characterCount: number;
  trailingContent?: ReactNode;
  onInlineFormat: (format: LatexInlineFormat) => void;
  onBlockFormat: (format: LatexBlockFormat) => void;
}

const sectioningOptions: Array<{
  format: LatexBlockFormat;
  label: string;
}> = [
  { format: "part", label: "Part" },
  { format: "chapter", label: "Chapter" },
  { format: "section", label: "Section" },
  { format: "subsection", label: "Subsection" },
  { format: "subsubsection", label: "Subsubsection" },
  { format: "paragraph", label: "Paragraph" },
  { format: "subparagraph", label: "Subparagraph" },
];

function ToolButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <Hint content={title}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label={label}
        onClick={onClick}
      >
        {children}
      </Button>
    </Hint>
  );
}

export function LatexEditorHeader({
  selectedWords,
  selectedCharacters,
  wordCount,
  characterCount,
  trailingContent,
  onInlineFormat,
  onBlockFormat,
}: LatexEditorHeaderProps) {
  const {
    headerRef,
    statisticsRef,
    otherControlsRef,
    overflow,
    otherControlsVisible,
    setActionsOpen,
  } = useEditorStatisticsOverflow();
  const words = `${selectedCharacters > 0 ? `${selectedWords.toLocaleString()}/` : ""}${wordCount.toLocaleString()}`;
  const characters = `${selectedCharacters > 0 ? `${selectedCharacters.toLocaleString()}/` : ""}${characterCount.toLocaleString()}`;
  return (
    <WorkspacePanelHeader
      ref={headerRef}
      actionsLabel="Editor"
      data-editor-statistics-overflow={overflow}
      hasTrailingContent={!overflow || otherControlsVisible}
      onActionsOpenChange={setActionsOpen}
      overflowContent={
        overflow ? (
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
            aria-hidden={overflow || undefined}
            style={
              overflow
                ? {
                    position: "absolute",
                    visibility: "hidden",
                    pointerEvents: "none",
                  }
                : undefined
            }
            data-testid="latex-editor-statistics"
            className="flex w-max shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums"
            role="group"
            aria-label={
              selectedCharacters > 0
                ? `${selectedWords} of ${wordCount} words, ${selectedCharacters} of ${characterCount} characters selected`
                : `${wordCount} words, ${characterCount} characters`
            }
          >
            <span data-testid="latex-word-count">{words} words</span>
            <span aria-hidden="true" className="text-muted-foreground/60">
              ·
            </span>
            <span data-testid="latex-character-count">{characters} chars</span>
          </div>
          <div ref={otherControlsRef} className="flex shrink-0 items-center">
            {trailingContent}
          </div>
        </>
      }
      data-testid="latex-editor-toolbar"
      className="flex h-12 shrink-0 items-center gap-2 border-border border-b bg-background px-2"
    >
      <FormattingControls
        statisticsOverflow={overflow}
        onInlineFormat={onInlineFormat}
        onBlockFormat={onBlockFormat}
      />
    </WorkspacePanelHeader>
  );
}

const FormattingControls = memo(function FormattingControls({
  statisticsOverflow,
  onInlineFormat,
  onBlockFormat,
}: Pick<LatexEditorHeaderProps, "onInlineFormat" | "onBlockFormat"> & {
  statisticsOverflow: boolean;
}) {
  return (
    <ResponsiveFormattingTools forceCollapsed={statisticsOverflow}>
      <div className="flex min-w-max items-center gap-0.5">
        <DropdownMenu>
          <Hint content="Sectioning command">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                aria-label="Sectioning command"
              >
                <HeadingIcon className="size-3.5" />
                <ChevronDownIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent
            align="start"
            sideOffset={6}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {sectioningOptions.map((option) => (
              <DropdownMenuItem
                key={option.format}
                onSelect={() => onBlockFormat(option.format)}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="mx-1 h-5 w-px bg-border" />

        <ToolButton
          label="Bold"
          shortcut="⌘B"
          onClick={() => onInlineFormat("bold")}
        >
          <BoldIcon className="size-3.5" />
        </ToolButton>
        <ToolButton
          label="Italic"
          shortcut="⌘I"
          onClick={() => onInlineFormat("italic")}
        >
          <ItalicIcon className="size-3.5" />
        </ToolButton>

        <div className="mx-1 h-5 w-px bg-border" />

        <ToolButton label="Quote" onClick={() => onBlockFormat("quote")}>
          <QuoteIcon className="size-3.5" />
        </ToolButton>
        <ToolButton
          label="Bulleted list"
          onClick={() => onBlockFormat("unordered-list")}
        >
          <ListIcon className="size-3.5" />
        </ToolButton>
        <ToolButton
          label="Numbered list"
          onClick={() => onBlockFormat("ordered-list")}
        >
          <ListOrderedIcon className="size-3.5" />
        </ToolButton>
        <ToolButton label="Link" onClick={() => onInlineFormat("link")}>
          <LinkIcon className="size-3.5" />
        </ToolButton>
        <ToolButton
          label="Monospace text"
          onClick={() => onInlineFormat("code")}
        >
          <Code2Icon className="size-3.5" />
        </ToolButton>
        <ToolButton
          label="Inline math"
          onClick={() => onInlineFormat("inline-math")}
        >
          <SigmaIcon className="size-3.5" />
        </ToolButton>
      </div>
    </ResponsiveFormattingTools>
  );
});
