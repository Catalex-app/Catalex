import { useLibraryPromptsExpanded } from "@/hooks/use-library-prompts-expanded";
import { ButtonGroup } from "@/components/ui/button-group";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/ui/tooltip";
import { invoke } from "@/lib/desktop/core";
import {
  resolveLibraryPromptContext,
  visiblePromptLibrary,
  type LibraryPrompt,
} from "@/lib/prompt-library";
import { libraryPromptIcon } from "@/lib/prompt-icons";
import { cn } from "@/lib/utils";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  MoreHorizontalIcon,
  PinIcon,
} from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { toast } from "sonner";
import "./prompt-suggestions.css";

/** Send in the current conversation without consuming its composer draft. */
export function PromptSuggestions({
  compact = false,
  menuOnly = false,
  compactExpanded = true,
  onCompactExpandedChange,
  foldedPlacement,
}: {
  compact?: boolean;
  menuOnly?: boolean;
  compactExpanded?: boolean;
  onCompactExpandedChange?: (expanded: boolean) => void;
  foldedPlacement?: "half";
}) {
  const pinned = useSettingsStore((state) => state.keepMiniPromptsOpen);
  const setPinned = useSettingsStore((state) => state.setKeepMiniPromptsOpen);
  const cardsId = useId();
  const library = useSettingsStore((state) => state.promptLibrary);
  const activeTab = useAgentChatStore((state) =>
    state.tabs.find((tab) => tab.id === state.activeTabId),
  );
  const draft = activeTab?.draft;
  const folded = !useLibraryPromptsExpanded(activeTab, pinned);
  const setExpanded = (expanded: boolean) => {
    if (compact && onCompactExpandedChange) onCompactExpandedChange(expanded);
    else if (activeTab)
      useAgentChatStore
        .getState()
        .setMiniPromptsExpanded(activeTab.id, expanded);
  };
  const unpinAndFold = () => {
    setExpanded(false);
    setPinned(false);
  };
  const activeFile = useDocumentStore((state) =>
    state.files.find((file) => file.id === state.activeFileId),
  );
  const draftSessionId = useDocumentStore(
    (state) => state.agentWorkspaceSessionId,
  );
  const diagnostics = useDocumentStore((state) => state.promptDiagnostics);
  const projectRoot = useDocumentStore((state) => state.projectRoot);
  const prompts = visiblePromptLibrary(library).filter(
    (prompt) => prompt.enabled,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = scrollRef.current;
    if (menuOnly || !strip) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || strip.scrollWidth <= strip.clientWidth) return;
      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;
      if (delta === 0) return;
      event.preventDefault();
      strip.scrollLeft += delta;
    };
    // A non-passive listener prevents the wheel from also scrolling the workspace.
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [compact, menuOnly]);
  const Surface = compact ? ButtonGroup : "div";
  const resolve = (prompt: LibraryPrompt) =>
    resolveLibraryPromptContext(
      prompt,
      draft?.pinnedContexts ?? [],
      activeFile,
      draftSessionId,
      diagnostics,
      projectRoot,
    );
  const send = (prompt: LibraryPrompt) => {
    const result = resolve(prompt);
    if (result.unavailable) return;
    void useAgentChatStore
      .getState()
      .sendPrompt(prompt.prompt, result.context ? [result.context] : [])
      .catch((error) => toast.error(`Could not send prompt: ${String(error)}`));
  };
  const manage = () => {
    void invoke("open_settings_window", { section: "agent" }).catch((error) =>
      toast.error(`Could not open Settings: ${String(error)}`),
    );
  };

  const controls = (
    <div
      data-prompt-divider={
        !compact && !menuOnly && !folded ? "left" : undefined
      }
      className={
        compact || menuOnly
          ? "contents"
          : cn(
              "flex shrink-0 flex-col",
              folded ? "w-[21px]" : "w-6 border-border/70 border-l",
            )
      }
    >
      {!compact && !menuOnly && (
        <Hint
          content={
            pinned
              ? "Unpin and collapse"
              : folded
                ? "Show prompt cards"
                : "Hide prompt cards"
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "h-auto min-h-7 w-full flex-1 rounded-none p-0",
              folded && "text-muted-foreground",
            )}
            aria-label={
              pinned
                ? "Unpin and collapse"
                : folded
                  ? "Show prompt cards"
                  : "Hide prompt cards"
            }
            aria-expanded={!folded}
            aria-controls={cardsId}
            onClick={() => (pinned ? unpinAndFold() : setExpanded(folded))}
          >
            {pinned ? (
              <PinIcon className="size-3.5" />
            ) : folded ? (
              <ChevronUpIcon className="size-3.5" />
            ) : (
              <ChevronDownIcon className="size-3.5" />
            )}
          </Button>
        </Hint>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={menuOnly ? "Prompts" : "All prompts"}
            data-prompt-divider={compact ? "left" : undefined}
            className={
              compact
                ? "h-full w-[21px] shrink-0 rounded-none rounded-r-[5px] border-border/70 border-l p-0 has-[>svg]:px-0"
                : menuOnly
                  ? "h-7 text-muted-foreground text-xs"
                  : cn(
                      "h-auto min-h-0 w-full flex-1 rounded-none border-border/70 border-t p-0 has-[>svg]:px-0",
                      folded && "hidden",
                    )
            }
          >
            {menuOnly ? "Prompts" : <MoreHorizontalIcon className="size-3" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="max-w-xs">
          {prompts.map((prompt) => {
            const { unavailable } = resolve(prompt);
            const Icon = libraryPromptIcon(prompt);
            return (
              <DropdownMenuItem
                key={prompt.id}
                disabled={Boolean(unavailable) || !draft}
                onSelect={() => send(prompt)}
              >
                <span className="flex max-w-full items-center gap-1.5">
                  {Icon && (
                    <Icon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="truncate">{prompt.title}</span>
                </span>
              </DropdownMenuItem>
            );
          })}
          {prompts.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuCheckboxItem
            checked={pinned}
            indicatorPosition="end"
            onCheckedChange={(checked) => {
              if (checked) setPinned(true);
              else unpinAndFold();
            }}
          >
            Pin prompt bar
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem onSelect={manage}>Manage prompts…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <Surface
      variant={compact ? "plain" : undefined}
      aria-label={compact ? "Suggested prompts" : undefined}
      data-prompt-suggestions={
        menuOnly ? "menu" : compact ? "compact" : "cards"
      }
      data-folded-prompt-toggle={folded ? foldedPlacement : undefined}
      className={cn(
        menuOnly
          ? "flex shrink-0"
          : compact
            ? cn(
                "absolute top-0 right-0 flex h-[30px] min-w-0 items-stretch overflow-hidden rounded-md border border-border/70 bg-muted/30 p-0 outline-none transition-[width] duration-200 ease-out motion-reduce:transition-none",
                compactExpanded ? "w-full" : "w-[23px]",
              )
            : cn(
                "ml-auto flex min-h-[30px] min-w-0 shrink-0 items-stretch overflow-hidden border border-border/70 transition-[width,border-radius] duration-200 ease-out motion-reduce:transition-none",
                folded
                  ? "w-[23px] rounded-md bg-background"
                  : "w-full rounded-xl bg-muted/10",
              ),
      )}
    >
      {compact && (
        <Hint
          content={
            pinned
              ? "Unpin and collapse"
              : compactExpanded
                ? "Hide prompts"
                : "Show prompts"
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            data-prompt-divider={compactExpanded ? "right" : undefined}
            className={cn(
              "h-full w-[21px] shrink-0 rounded-none rounded-l-[5px] p-0",
              compactExpanded
                ? "border-border/70 border-r"
                : "rounded-r-[5px] text-muted-foreground",
            )}
            aria-label={
              pinned
                ? "Unpin and collapse"
                : compactExpanded
                  ? "Hide prompts"
                  : "Show prompts"
            }
            aria-expanded={compactExpanded}
            aria-controls={cardsId}
            onClick={() => {
              if (pinned) {
                unpinAndFold();
              } else setExpanded(!compactExpanded);
            }}
          >
            {pinned ? (
              <PinIcon className="size-3" />
            ) : (
              <ChevronLeftIcon
                className={cn(
                  "size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none",
                  compactExpanded && "rotate-180",
                )}
              />
            )}
          </Button>
        </Hint>
      )}
      {!menuOnly && (
        <div
          id={cardsId}
          ref={scrollRef}
          data-prompt-scroll=""
          aria-hidden={(compact ? !compactExpanded : folded) || undefined}
          inert={compact ? !compactExpanded : folded}
          className={
            compact
              ? cn(
                  "scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto transition-[opacity,visibility] duration-150 ease-out motion-reduce:transition-none",
                  compactExpanded
                    ? "visible opacity-100"
                    : "invisible opacity-0",
                )
              : cn(
                  "scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto transition-[max-height,opacity,visibility] duration-200 ease-out motion-reduce:transition-none",
                  folded
                    ? "invisible max-h-0 opacity-0"
                    : "visible max-h-28 opacity-100",
                )
          }
        >
          {prompts.map((prompt, index) => {
            const { unavailable } = resolve(prompt);
            const Icon = libraryPromptIcon(prompt);
            return (
              <Hint key={prompt.id} content={unavailable ?? prompt.prompt}>
                <Button
                  variant="ghost"
                  size="sm"
                  data-prompt-divider={
                    index < prompts.length - 1 ? "right" : undefined
                  }
                  disabled={Boolean(unavailable) || !draft}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => send(prompt)}
                  className={
                    compact
                      ? "h-full min-w-max flex-1 shrink-0 rounded-none border-border/70 border-r px-3 font-normal text-xs shadow-none last:border-r-0"
                      : "h-auto min-h-18 min-w-44 flex-1 shrink-0 flex-col items-start justify-start gap-1 whitespace-normal rounded-none border-border/70 border-r px-4 py-2 text-left font-normal shadow-none last:border-r-0"
                  }
                >
                  <span className="flex max-w-full items-center gap-1.5">
                    {Icon && (
                      <Icon
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span
                      className={
                        compact
                          ? "whitespace-nowrap"
                          : "line-clamp-2 font-medium text-xs"
                      }
                    >
                      {prompt.title}
                    </span>
                  </span>
                  {!compact && (
                    <span className="line-clamp-2 text-[11px] text-muted-foreground leading-4">
                      {unavailable ?? prompt.prompt}
                    </span>
                  )}
                </Button>
              </Hint>
            );
          })}
        </div>
      )}
      {compact && (
        <div
          aria-hidden={!compactExpanded}
          inert={!compactExpanded}
          className={cn(
            "flex h-full shrink-0 transition-[opacity,visibility] duration-150 ease-out motion-reduce:transition-none",
            compactExpanded ? "visible opacity-100" : "invisible opacity-0",
          )}
        >
          {controls}
        </div>
      )}
      {!compact && controls}
    </Surface>
  );
}
