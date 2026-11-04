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
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  StrikethroughIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type MarkdownInlineFormat =
  | "bold"
  | "italic"
  | "strikethrough"
  | "link"
  | "code";

export type MarkdownBlockFormat =
  | "paragraph"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "heading-5"
  | "heading-6"
  | "blockquote"
  | "unordered-list"
  | "ordered-list"
  | "checklist";

interface MarkdownEditorHeaderProps {
  selectedWords: number;
  selectedCharacters: number;
  wordCount: number;
  characterCount: number;
  trailingContent?: ReactNode;
  onInlineFormat: (format: MarkdownInlineFormat) => void;
  onBlockFormat: (format: MarkdownBlockFormat) => void;
}

const headingOptions: Array<{
  format: MarkdownBlockFormat;
  label: string;
}> = [
  { format: "paragraph", label: "Paragraph" },
  { format: "heading-1", label: "Heading 1" },
  { format: "heading-2", label: "Heading 2" },
  { format: "heading-3", label: "Heading 3" },
  { format: "heading-4", label: "Heading 4" },
  { format: "heading-5", label: "Heading 5" },
  { format: "heading-6", label: "Heading 6" },
];

const inlineTools: Array<{
  format: MarkdownInlineFormat;
  label: string;
  shortcut?: string;
  icon: typeof BoldIcon;
}> = [
  { format: "bold", label: "Bold", shortcut: "⌘B", icon: BoldIcon },
  { format: "italic", label: "Italic", shortcut: "⌘I", icon: ItalicIcon },
  {
    format: "strikethrough",
    label: "Strikethrough",
    icon: StrikethroughIcon,
  },
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
  children: React.ReactNode;
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

export function MarkdownEditorHeader({
  selectedWords,
  selectedCharacters,
  wordCount,
  characterCount,
  trailingContent,
  onInlineFormat,
  onBlockFormat,
}: MarkdownEditorHeaderProps) {
  return (
    <WorkspacePanelHeader
      data-testid="markdown-editor-toolbar"
      className="flex h-12 shrink-0 items-center gap-2 border-border border-b bg-background px-2"
    >
      <FormattingControls
        onInlineFormat={onInlineFormat}
        onBlockFormat={onBlockFormat}
      />

      <div
        data-testid="markdown-editor-statistics"
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums"
        role="group"
        aria-label={
          selectedCharacters > 0
            ? `${selectedWords} of ${wordCount} words, ${selectedCharacters} of ${characterCount} characters selected`
            : `${wordCount} words, ${characterCount} characters`
        }
      >
        <span data-testid="markdown-word-count">
          {selectedCharacters > 0 ? `${selectedWords.toLocaleString()}/` : ""}
          {wordCount.toLocaleString()} words
        </span>
        <span aria-hidden="true" className="text-muted-foreground/60">
          ·
        </span>
        <span data-testid="markdown-character-count">
          {selectedCharacters > 0
            ? `${selectedCharacters.toLocaleString()}/`
            : ""}
          {characterCount.toLocaleString()} chars
        </span>
      </div>
      {trailingContent}
    </WorkspacePanelHeader>
  );
}

const FormattingControls = memo(function FormattingControls({
  onInlineFormat,
  onBlockFormat,
}: Pick<MarkdownEditorHeaderProps, "onInlineFormat" | "onBlockFormat">) {
  return (
    <ResponsiveFormattingTools>
      <div className="flex min-w-max items-center gap-0.5">
        <DropdownMenu>
          <Hint content="Heading style">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                aria-label="Heading style"
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
            {headingOptions.map((option) => (
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

        {inlineTools.map((tool) => {
          const Icon = tool.icon;
          return (
            <ToolButton
              key={tool.format}
              label={tool.label}
              shortcut={tool.shortcut}
              onClick={() => onInlineFormat(tool.format)}
            >
              <Icon className="size-3.5" />
            </ToolButton>
          );
        })}

        <div className="mx-1 h-5 w-px bg-border" />

        <ToolButton
          label="Blockquote"
          onClick={() => onBlockFormat("blockquote")}
        >
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
        <ToolButton
          label="Checklist"
          onClick={() => onBlockFormat("checklist")}
        >
          <ListChecksIcon className="size-3.5" />
        </ToolButton>
        <ToolButton label="Link" onClick={() => onInlineFormat("link")}>
          <LinkIcon className="size-3.5" />
        </ToolButton>
        <ToolButton label="Inline code" onClick={() => onInlineFormat("code")}>
          <Code2Icon className="size-3.5" />
        </ToolButton>
      </div>
    </ResponsiveFormattingTools>
  );
});
