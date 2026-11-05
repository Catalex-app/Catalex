import { useEffect, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Trash2Icon,
  ImageIcon,
  BanIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  libraryPromptIcon,
  loadPromptIconNames,
  promptIcon,
  promptIconLabel,
} from "@/lib/prompt-icons";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Hint } from "@/components/ui/tooltip";
import {
  defaultPromptIconName,
  PROMPT_AVAILABILITY_OPTIONS,
  PROMPT_ICON_NAMES,
  resolvePromptIcon,
  type LibraryPrompt,
  type PromptIconName,
} from "@/lib/prompt-library";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { SettingsDropdown } from "./settings-dropdown";
import { SettingsGroup, SettingsRow } from "./settings-layout";
import { SettingsSwitch } from "./settings-switch";

const ICONS_PER_PAGE = 36;

export function PromptLibrarySettings() {
  const prompts = useSettingsStore((state) => state.promptLibrary);
  const save = useSettingsStore((state) => state.saveLibraryPrompt);
  const remove = useSettingsStore((state) => state.deleteLibraryPrompt);
  const move = useSettingsStore((state) => state.moveLibraryPrompt);
  const [draft, setDraft] = useState<LibraryPrompt | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconSearch, setIconSearch] = useState("");
  const [browseIcons, setBrowseIcons] = useState(false);
  const [iconPage, setIconPage] = useState(0);
  const [iconCatalog, setIconCatalog] = useState<PromptIconName[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const selectedIcon = draft ? resolvePromptIcon(draft) : null;
  const DraftIcon = draft ? libraryPromptIcon(draft) : undefined;
  const DefaultIcon = draft
    ? promptIcon(defaultPromptIconName(draft.id))
    : null;
  const query = iconSearch
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, " ");
  const showCatalog = browseIcons || query !== "";
  useEffect(() => {
    if (!iconPickerOpen || !showCatalog || iconCatalog) return;
    let active = true;
    loadPromptIconNames().then(
      (names) => {
        if (active) setIconCatalog(names);
      },
      () => {
        if (active) setCatalogFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [iconPickerOpen, showCatalog, iconCatalog]);
  const matchingIcons = (
    showCatalog ? (iconCatalog ?? []) : PROMPT_ICON_NAMES
  ).filter(
    (name) =>
      name.replace(/-/g, " ").includes(query) ||
      promptIconLabel(name).toLowerCase().includes(query),
  );
  const pageCount = Math.ceil(matchingIcons.length / ICONS_PER_PAGE);
  const visibleIcons = matchingIcons.slice(
    iconPage * ICONS_PER_PAGE,
    (iconPage + 1) * ICONS_PER_PAGE,
  );

  return (
    <div data-settings-row-id="agent-prompt-library" className="scroll-mt-4">
      <SettingsGroup
        title="Prompt Library"
        titleAction={
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={Boolean(draft)}
            onClick={() => {
              setDeleteId(null);
              setDraft({
                id: crypto.randomUUID(),
                title: "",
                prompt: "",
                availability: "always",
                enabled: true,
              });
            }}
          >
            Add prompt
          </Button>
        }
      >
        {prompts.map((prompt, index) => {
          const Icon = libraryPromptIcon(prompt);
          return (
            <div
              key={prompt.id}
              data-library-prompt-id={prompt.id}
              className="flex min-w-0 flex-wrap items-center gap-1 border-border/45 border-b py-2"
            >
              <button
                type="button"
                className="min-w-0 flex-1 rounded-md px-1 py-1 text-left text-sm hover:bg-muted"
                disabled={Boolean(draft)}
                aria-label={`Edit ${prompt.title}`}
                onClick={() => {
                  setDeleteId(null);
                  setDraft({ ...prompt });
                }}
              >
                <span className="flex items-center gap-1.5">
                  {Icon && (
                    <Icon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="truncate">{prompt.title}</span>
                </span>
                <span className="block truncate text-muted-foreground text-xs">
                  {
                    PROMPT_AVAILABILITY_OPTIONS.find(
                      (option) => option.value === prompt.availability,
                    )?.label
                  }
                </span>
              </button>
              <SettingsSwitch
                size="sm"
                label={`Enable ${prompt.title}`}
                checked={prompt.enabled}
                onCheckedChange={(enabled) => {
                  save({ ...prompt, enabled });
                  setDraft((current) =>
                    current?.id === prompt.id
                      ? { ...current, enabled }
                      : current,
                  );
                }}
              />
              <Hint content="Move up">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${prompt.title} up`}
                  disabled={index === 0}
                  onClick={() => move(prompt.id, -1)}
                >
                  <ArrowUpIcon className="size-3.5" />
                </Button>
              </Hint>
              <Hint content="Move down">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${prompt.title} down`}
                  disabled={index === prompts.length - 1}
                  onClick={() => move(prompt.id, 1)}
                >
                  <ArrowDownIcon className="size-3.5" />
                </Button>
              </Hint>
              {deleteId === prompt.id ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      remove(prompt.id);
                      setDeleteId(null);
                    }}
                  >
                    Delete
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setDeleteId(null)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Hint content="Delete">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${prompt.title}`}
                    disabled={Boolean(draft)}
                    onClick={() => setDeleteId(prompt.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </Hint>
              )}
            </div>
          );
        })}
        {prompts.length === 0 && !draft && (
          <p className="py-3 text-muted-foreground text-sm">
            No saved prompts.
          </p>
        )}
        {draft && (
          <form
            className="space-y-2 py-3"
            aria-label="Edit library prompt"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.title.trim() || !draft.prompt.trim()) return;
              save(draft);
              setDraft(null);
            }}
          >
            <div className="flex items-center gap-2">
              <Popover
                open={iconPickerOpen}
                onOpenChange={(open) => {
                  setIconPickerOpen(open);
                  setIconSearch("");
                  setBrowseIcons(false);
                  setIconPage(0);
                  setCatalogFailed(false);
                }}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`Prompt icon: ${draft.icon === undefined ? "Default icon" : selectedIcon ? promptIconLabel(selectedIcon) : "No icon"}`}
                  >
                    {DraftIcon ? (
                      <DraftIcon aria-hidden="true" className="size-4" />
                    ) : (
                      <ImageIcon
                        aria-hidden="true"
                        className="size-4 text-muted-foreground"
                      />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 space-y-2 p-2">
                  <Input
                    aria-label="Search icons"
                    placeholder="Search icons…"
                    value={iconSearch}
                    onChange={(event) => {
                      setIconSearch(event.target.value);
                      setIconPage(0);
                    }}
                  />
                  <div className="grid grid-cols-2 gap-1">
                    <Button
                      type="button"
                      variant={draft.icon === undefined ? "secondary" : "ghost"}
                      size="sm"
                      aria-pressed={draft.icon === undefined}
                      onClick={() => {
                        setDraft({ ...draft, icon: undefined });
                        setIconPickerOpen(false);
                      }}
                    >
                      {DefaultIcon && (
                        <DefaultIcon aria-hidden="true" className="size-4" />
                      )}
                      Default icon
                    </Button>
                    <Button
                      type="button"
                      variant={draft.icon === null ? "secondary" : "ghost"}
                      size="sm"
                      aria-pressed={draft.icon === null}
                      onClick={() => {
                        setDraft({ ...draft, icon: null });
                        setIconPickerOpen(false);
                      }}
                    >
                      <BanIcon aria-hidden="true" className="size-4" /> No icon
                    </Button>
                  </div>
                  <ButtonGroup
                    aria-label="Icon catalog"
                    className="flex items-center gap-1"
                  >
                    {(["Suggested", "All icons"] as const).map((label) => {
                      const all = label === "All icons";
                      const selected = all === showCatalog;
                      return (
                        <Button
                          key={label}
                          type="button"
                          size="xs"
                          variant="ghost"
                          aria-pressed={selected}
                          className={cn(
                            "flex-1",
                            selected
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                          )}
                          onClick={() => {
                            setBrowseIcons(all);
                            setIconPage(0);
                            if (!all) setIconSearch("");
                          }}
                        >
                          {label}
                        </Button>
                      );
                    })}
                  </ButtonGroup>
                  <div className="grid grid-cols-6 gap-1">
                    {visibleIcons.map((name) => {
                      const label = promptIconLabel(name);
                      const Icon = promptIcon(name);
                      const picked = draft.icon === name;
                      return (
                        <Hint key={name} content={label}>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant={picked ? "secondary" : "ghost"}
                            aria-label={label}
                            aria-pressed={picked}
                            onClick={() => {
                              setDraft({ ...draft, icon: name });
                              setIconPickerOpen(false);
                            }}
                          >
                            <Icon aria-hidden="true" className="size-4" />
                          </Button>
                        </Hint>
                      );
                    })}
                  </div>
                  {showCatalog && matchingIcons.length === 0 && (
                    <p className="px-1 py-2 text-muted-foreground text-xs">
                      {catalogFailed
                        ? "Couldn’t load icons."
                        : iconCatalog
                          ? "No matching icons."
                          : "Loading icons…"}
                    </p>
                  )}
                  {pageCount > 1 && (
                    <div className="flex items-center justify-between text-muted-foreground text-xs">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={iconPage === 0}
                        onClick={() => setIconPage(iconPage - 1)}
                      >
                        Previous
                      </Button>
                      <span aria-live="polite">
                        {iconPage + 1} / {pageCount}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={iconPage + 1 === pageCount}
                        onClick={() => setIconPage(iconPage + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
              <Input
                autoFocus
                aria-label="Prompt title"
                placeholder="Prompt title"
                value={draft.title}
                onChange={(event) =>
                  setDraft({ ...draft, title: event.target.value })
                }
              />
            </div>
            <Textarea
              aria-label="Prompt text"
              placeholder="What should the agent do?"
              className="min-h-28 text-sm"
              value={draft.prompt}
              onChange={(event) =>
                setDraft({ ...draft, prompt: event.target.value })
              }
            />
            <SettingsRow title="Available when">
              <SettingsDropdown
                ariaLabel="Prompt availability"
                value={draft.availability}
                options={PROMPT_AVAILABILITY_OPTIONS}
                onChange={(availability) =>
                  setDraft({ ...draft, availability })
                }
              />
            </SettingsRow>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!draft.title.trim() || !draft.prompt.trim()}
              >
                Save prompt
              </Button>
            </div>
          </form>
        )}
      </SettingsGroup>
    </div>
  );
}
