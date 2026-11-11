import { useAppActions } from "@/hooks/use-app-actions";
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
  DropdownMenuLabel,
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
  findAction?: () => void;
  findOpen?: boolean;
  actionTarget?: boolean;
  actionsEnabled?: boolean;
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

function ToolButton({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  disabled: boolean;
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
        disabled={disabled}
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
  findAction,
  findOpen,
  actionTarget = true,
  actionsEnabled = true,
  onInlineFormat,
  onBlockFormat,
}: MarkdownEditorHeaderProps) {
  const {
    headerRef,
    statisticsRef,
    otherControlsRef,
    overflow,
    findInOverflow,
    otherControlsVisible,
    setActionsOpen,
  } = useEditorStatisticsOverflow(!!findAction && !findOpen);
  const words = `${selectedCharacters > 0 ? `${selectedWords.toLocaleString()}/` : ""}${wordCount.toLocaleString()}`;
  const characters = `${selectedCharacters > 0 ? `${selectedCharacters.toLocaleString()}/` : ""}${characterCount.toLocaleString()}`;
  return (
    <WorkspacePanelHeader
      ref={headerRef}
      findAction={findAction}
      findOpen={findOpen}
      findInOverflow={findInOverflow}
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
            data-testid="markdown-editor-statistics"
            className="flex w-max shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums"
            role="group"
            aria-label={
              selectedCharacters > 0
                ? `${selectedWords} of ${wordCount} words, ${selectedCharacters} of ${characterCount} characters selected`
                : `${wordCount} words, ${characterCount} characters`
            }
          >
            <span data-testid="markdown-word-count">{words} words</span>
            <span aria-hidden="true" className="text-muted-foreground/60">
              ·
            </span>
            <span data-testid="markdown-character-count">
              {characters} chars
            </span>
          </div>
          <div ref={otherControlsRef} className="flex shrink-0 items-center">
            {trailingContent}
          </div>
        </>
      }
      data-testid="markdown-editor-toolbar"
      className="flex h-12 shrink-0 items-center gap-2 border-border border-b bg-background px-2"
    >
      <FormattingControls
        statisticsOverflow={overflow}
        actionTarget={actionTarget}
        actionsEnabled={actionsEnabled}
        onInlineFormat={onInlineFormat}
        onBlockFormat={onBlockFormat}
      />
    </WorkspacePanelHeader>
  );
}

const FormattingControls = memo(function FormattingControls({
  statisticsOverflow,
  actionTarget,
  actionsEnabled,
  onInlineFormat,
  onBlockFormat,
}: Pick<
  MarkdownEditorHeaderProps,
  "onInlineFormat" | "onBlockFormat" | "actionTarget" | "actionsEnabled"
> & {
  statisticsOverflow: boolean;
}) {
  const tools = [
    {
      id: "inline:bold",
      label: "Bold",
      icon: BoldIcon,
      hint: "⌘B",
      run: () => onInlineFormat("bold"),
    },
    {
      id: "inline:italic",
      label: "Italic",
      icon: ItalicIcon,
      hint: "⌘I",
      run: () => onInlineFormat("italic"),
    },
    {
      id: "inline:strikethrough",
      label: "Strikethrough",
      icon: StrikethroughIcon,
      hint: undefined,
      run: () => onInlineFormat("strikethrough"),
    },
    {
      id: "block:blockquote",
      label: "Blockquote",
      icon: QuoteIcon,
      hint: undefined,
      run: () => onBlockFormat("blockquote"),
    },
    {
      id: "block:unordered-list",
      label: "Bulleted list",
      icon: ListIcon,
      hint: undefined,
      run: () => onBlockFormat("unordered-list"),
    },
    {
      id: "block:ordered-list",
      label: "Numbered list",
      icon: ListOrderedIcon,
      hint: undefined,
      run: () => onBlockFormat("ordered-list"),
    },
    {
      id: "block:checklist",
      label: "Checklist",
      icon: ListChecksIcon,
      hint: undefined,
      run: () => onBlockFormat("checklist"),
    },
    {
      id: "inline:link",
      label: "Link",
      icon: LinkIcon,
      hint: undefined,
      run: () => onInlineFormat("link"),
    },
    {
      id: "inline:code",
      label: "Inline code",
      icon: Code2Icon,
      hint: undefined,
      run: () => onInlineFormat("code"),
    },
  ];
  const actions = useAppActions(
    [
      ...headingOptions.map((option, order) => ({
        id: `block:${option.format}`,
        label: option.label,
        run: () => onBlockFormat(option.format),
        enabled: actionsEnabled,
        menu: { group: "Format" as const, section: 1, order },
      })),
      ...tools.map((tool, order) => ({
        ...tool,
        enabled: actionsEnabled,
        shortcut:
          tool.id === "inline:bold"
            ? "Mod+KeyB"
            : tool.id === "inline:italic"
              ? "Mod+KeyI"
              : undefined,
        menu: { group: "Format" as const, section: 0, order },
      })),
    ],
    actionTarget ? "active" : "inactive",
  );
  return (
    <ResponsiveFormattingTools
      forceCollapsed={statisticsOverflow}
      disabled={actionsEnabled === false}
    >
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
                disabled={actionsEnabled === false}
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
            {actions.slice(0, headingOptions.length).map((option) => (
              <DropdownMenuItem
                key={option.id}
                disabled={option.enabled === false}
                onSelect={option.run}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="mx-1 h-5 w-px bg-border" />
        {tools.map((tool, index) => {
          const Icon = tool.icon;
          const action = actions[headingOptions.length + index];
          return (
            <span key={tool.id} className="contents">
              {index === 3 && <div className="mx-1 h-5 w-px bg-border" />}
              <ToolButton
                label={action.label}
                shortcut={tool.hint}
                disabled={action.enabled === false}
                onClick={action.run}
              >
                <Icon className="size-3.5" />
              </ToolButton>
            </span>
          );
        })}
      </div>
    </ResponsiveFormattingTools>
  );
});
