import { SearchablePicker } from "@/components/ui/searchable-picker";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useMemo, useState } from "react";
import {
  LinkIcon,
  Trash2Icon,
  CircleHelpIcon,
  ChevronRightIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { invoke } from "@/lib/desktop/core";
import { open } from "@/lib/desktop/dialog";
import { PROJECT_COMMENTS_REFRESH_EVENT } from "@/lib/workspace-events";
import { useDocumentStore } from "@/stores/document-store";
import { ActionSelector } from "../action-selector";
import { setCommentDraft } from "./comment-draft-history";
import { reconnectTrackedComments } from "./comment-paths";
import { commentLabel } from "./inline-comments";
import {
  withCommentPathMutation,
  type InlineCommentsByFile,
} from "./inline-comment-storage";

type Result = {
  newPath: string;
  unplaced: number;
  cleared: number;
  links?: { oldPath: string; newPath: string; ids: string[] }[];
  linked?: number;
  remaining?: number;
};
export function CommentFileManager({
  root,
  files,
  groups,
  disabled,
  onBusyChange,
}: {
  root: string;
  files: InlineCommentsByFile;
  groups: InlineCommentsByFile;
  disabled: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const checkboxId = useId();
  const projectFiles = useDocumentStore((state) => state.files);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<"clear" | "relink" | "auto-relink">(
    "clear",
  );
  const [author, setAuthor] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [validation, setValidation] = useState<{
    key: string;
    result?: Result;
    error?: string;
  } | null>(null);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const allEntries = useMemo(
    () =>
      [
        ...Object.entries(files).map(([path, comments]) => ({
          path,
          comments,
          disconnected: false,
          key: JSON.stringify([false, path]),
        })),
        ...Object.entries(groups).map(([path, comments]) => ({
          path,
          comments,
          disconnected: true,
          key: JSON.stringify([true, path]),
        })),
      ]
        .filter((group) => group.comments.length)
        .sort(
          (a, b) =>
            a.path.localeCompare(b.path) ||
            Number(a.disconnected) - Number(b.disconnected),
        ),
    [files, groups],
  );
  // Selection/action changes do not change the expanded comment rows. Reuse
  // their elements instead of rebuilding up to thousands of rows per click.
  const expandedRows = useMemo(
    () =>
      new Map(
        allEntries
          .filter(({ key }) => expanded.has(key))
          .map(({ key, comments }) => [
            key,
            comments.map((comment) => (
              <div
                key={comment.id}
                className="border-border border-b py-2 pl-6 text-muted-foreground text-sm last:border-b-0"
              >
                <p className="whitespace-pre-wrap break-words">
                  {comment.text}
                </p>
                <p className="mt-1 text-xs">
                  {commentLabel(comment)} · {comment.origin ? "Agent" : "Human"}{" "}
                  · {comment.resolved ? "Resolved" : "Open"}
                </p>
              </div>
            )),
          ]),
      ),
    [allEntries, expanded],
  );
  const entries = allEntries.filter(
    (group) =>
      filter === "all" || group.disconnected === (filter === "disconnected"),
  );
  const selectedGroups = entries.filter((group) =>
    selected.includes(group.key),
  );
  const selection = selectedGroups.map((group) => ({
    path: group.path,
    disconnected: group.disconnected,
    ids: group.comments.map((comment) => comment.id),
  }));
  const autoRelinkable =
    selectedGroups.length > 0 &&
    selectedGroups.every((group) => group.disconnected);
  const selectedComments = selectedGroups.flatMap((group) => group.comments);
  const authorCounts = {
    all: selectedComments.length,
    agent: selectedComments.filter((comment) => Boolean(comment.origin)).length,
    human: selectedComments.filter((comment) => !comment.origin).length,
  };
  const clearable = authorCounts[author as keyof typeof authorCounts];
  const request = { projectRoot: root, selection, author, action, target };
  const validationKey = JSON.stringify(request);
  useEffect(() => {
    if (action !== "relink" || selected.length !== 1 || !target) {
      setValidation(null);
      return;
    }
    let active = true;
    setValidation(null);
    const args = JSON.parse(validationKey);
    invoke<Result>("manage_comment_files", { ...args, preview: true }).then(
      (result) => {
        if (active) setValidation({ key: validationKey, result });
      },
      (error) => {
        if (active) setValidation({ key: validationKey, error: String(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [validationKey, action, selected.length, target, groups]);
  const changeSelection = (paths: string[]) => {
    setSelected(paths);
    setTarget("");
    setTargetQuery("");
    setError(null);
    setMessage(null);
    if (action === "relink" && paths.length !== 1) setAction("clear");
  };
  const chooseFile = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await open({
        title: "Reconnect comments to file",
        defaultPath: root,
        multiple: false,
        filters: [
          {
            name: "Text documents",
            extensions: [
              "tex",
              "md",
              "markdown",
              "txt",
              "bib",
              "sty",
              "cls",
              "ltx",
              "rnw",
              "rmd",
            ],
          },
        ],
      });
      if (path) {
        setTarget(path);
        setTargetQuery(path);
        setValidation(null);
        setMessage(null);
      }
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const valid = validation?.key === validationKey && !!validation.result;
  const execute = async () => {
    if (
      busy ||
      !selected.length ||
      (action === "relink" && !valid) ||
      (action === "clear" && !clearable) ||
      (action === "auto-relink" && !autoRelinkable)
    )
      return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await withCommentPathMutation(root, async () => {
        const result = await invoke<Result>("manage_comment_files", {
          ...request,
          preview: false,
        });
        if (action === "clear") {
          for (const group of selectedGroups) {
            for (const comment of group.comments) {
              if (
                author === "all" ||
                Boolean(comment.origin) === (author === "agent")
              )
                setCommentDraft(
                  { root, filePath: group.path },
                  comment.id,
                  null,
                );
            }
          }
        } else {
          // Only successful records move; failed automatic matches keep drafts.
          for (const link of result.links ?? []) {
            for (const id of link.ids)
              setCommentDraft({ root, filePath: link.oldPath }, id, null);
            reconnectTrackedComments(root, link.ids, link.newPath);
          }
        }
        return { ...result, pathChanges: [] };
      });
      setMessage(
        action === "clear"
          ? `${result.cleared} ${author === "all" ? "" : `${author} `}comments cleared.`
          : action === "auto-relink"
            ? `${result.linked ?? 0} comments relinked. ${result.remaining ?? 0} remain disconnected.`
            : `Comments linked to ${result.newPath}.${result.unplaced ? ` ${result.unplaced} need their positions reviewed.` : ""}`,
      );
      setSelected([]);
      setTarget("");
      setTargetQuery("");
      setValidation(null);
      setAction("clear");
    } catch (error) {
      setError(String(error));
      setValidation(null);
      // Success is published by the native service to every window. A failure
      // can still discover external changes, so reconcile the local view then.
      window.dispatchEvent(
        new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
          detail: { projectRoot: root },
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="File comments" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Tabs
          value={filter}
          onValueChange={(value) => {
            setFilter(value);
            changeSelection([]);
          }}
        >
          <TabsList
            aria-label="File connection status"
            className="h-8 border border-border/70"
          >
            <TabsTrigger value="all" disabled={busy || disabled}>
              All ({allEntries.length})
            </TabsTrigger>
            <TabsTrigger value="connected" disabled={busy || disabled}>
              Connected (
              {allEntries.filter((group) => !group.disconnected).length})
            </TabsTrigger>
            <Tooltip>
              <TabsTrigger
                value="disconnected"
                disabled={busy || disabled}
                className="gap-1.5"
              >
                Disconnected (
                {allEntries.filter((group) => group.disconnected).length})
                <TooltipTrigger asChild>
                  <span className="inline-flex" aria-hidden="true">
                    <CircleHelpIcon className="size-3.5 text-muted-foreground" />
                  </span>
                </TooltipTrigger>
              </TabsTrigger>
              <TooltipContent
                id={`${checkboxId}-disconnected-help`}
                className="max-w-64"
              >
                Comments whose file or selected text could not be recovered.
                They are preserved until you reconnect or clear them.
              </TooltipContent>
            </Tooltip>
          </TabsList>
        </Tabs>
        <span className="text-muted-foreground text-xs">
          {selected.length}/{entries.length} files selected
        </span>
      </div>
      <div className="app-scrollbar max-h-[min(280px,24vh)] overflow-y-auto">
        {entries.length > 0 && (
          <label
            htmlFor={`${checkboxId}-all`}
            className="flex items-center gap-2 border-border border-b py-2 font-medium text-sm"
          >
            <Checkbox
              id={`${checkboxId}-all`}
              mixed={selected.length > 0 && selected.length < entries.length}
              aria-label="Select all files"
              disabled={busy || disabled}
              checked={selected.length === entries.length}
              onChange={(event) =>
                changeSelection(
                  event.target.checked ? entries.map((group) => group.key) : [],
                )
              }
            />
            {filter === "all"
              ? "Select All"
              : filter === "connected"
                ? "Select All Connected"
                : "Select All Disconnected"}
          </label>
        )}
        {entries.map(({ path, comments, disconnected, key }) => (
          <div
            key={key}
            data-comment-link-group={path}
            data-disconnected={disconnected}
          >
            <div className="sticky top-0 z-10 flex items-center gap-2 border-border border-b bg-muted py-2 text-sm dark:bg-background">
              <Checkbox
                id={`${checkboxId}-${key}`}
                aria-label={`Select ${disconnected ? "disconnected " : ""}file ${path}`}
                checked={selected.includes(key)}
                disabled={busy || disabled}
                onChange={(event) =>
                  changeSelection(
                    event.target.checked
                      ? [...selected, key]
                      : selected.filter((item) => item !== key),
                  )
                }
              />
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-expanded={expanded.has(key)}
                aria-controls={`${checkboxId}-comments-${key}`}
                aria-label={`${expanded.has(key) ? "Collapse" : "Expand"} ${disconnected ? "disconnected " : ""}comments in ${path}`}
                onClick={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              >
                <ChevronRightIcon
                  className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded.has(key) ? "rotate-90" : ""}`}
                />
                <span
                  className="min-w-0 flex-1 truncate font-medium"
                  title={path}
                >
                  {path}
                </span>
                {disconnected && (
                  <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    Disconnected
                  </span>
                )}
                <span className="shrink-0 text-muted-foreground text-xs">
                  {comments.length}{" "}
                  {comments.length === 1 ? "comment" : "comments"}
                </span>
              </button>
            </div>
            <div
              id={`${checkboxId}-comments-${key}`}
              hidden={!expanded.has(key)}
            >
              {expandedRows.get(key)}
            </div>
          </div>
        ))}
        {!entries.length && (
          <p className="py-10 text-center text-muted-foreground text-sm">
            {!disabled
              ? filter === "all"
                ? "No comments."
                : `No ${filter} comments.`
              : "Loading comments…"}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <h3 className="font-semibold text-sm">Action</h3>
        <ActionSelector
          value={action}
          onChange={(value) => {
            setAction(value);
            setError(null);
            setMessage(null);
          }}
          disabled={busy || disabled}
          options={[
            {
              value: "clear",
              label: "Clear comments",
              accessory:
                action === "clear" &&
                !busy &&
                !disabled &&
                selected.length > 0 ? (
                  <Tabs
                    value={author}
                    onValueChange={(value) => {
                      setAuthor(value);
                      setAction("clear");
                      setMessage(null);
                    }}
                  >
                    <TabsList
                      aria-label="Comments to clear"
                      className="mr-2 h-7"
                    >
                      <TabsTrigger
                        value="all"
                        className="px-2 text-xs"
                        disabled={busy || disabled}
                      >
                        All ({authorCounts.all})
                      </TabsTrigger>
                      <TabsTrigger
                        value="agent"
                        className="px-2 text-xs"
                        disabled={busy || disabled}
                      >
                        Agent ({authorCounts.agent})
                      </TabsTrigger>
                      <TabsTrigger
                        value="human"
                        className="px-2 text-xs"
                        disabled={busy || disabled}
                      >
                        Human ({authorCounts.human})
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                ) : undefined,
              icon: Trash2Icon,
              destructive: true,
              disabled: !selected.length,
            },
            {
              value: "auto-relink",
              label: "Auto-relink selected",
              icon: LinkIcon,
              disabled: !autoRelinkable,
            },
            {
              value: "relink",
              label: "Reconnect comments to file",
              accessoryPosition: "below",
              accessory:
                action === "relink" ? (
                  <div className="flex w-full items-center gap-2 px-3 pb-3">
                    <SearchablePicker
                      label="Target file"
                      placeholder="Search project files…"
                      align="left"
                      disabled={busy || disabled}
                      query={targetQuery}
                      value={target}
                      onQueryChange={(query) => {
                        setTargetQuery(query);
                        setTarget("");
                        setValidation(null);
                        setError(null);
                      }}
                      options={projectFiles
                        .filter(
                          (file) =>
                            !targetQuery ||
                            targetQuery === target ||
                            file.relativePath
                              .toLowerCase()
                              .includes(targetQuery.toLowerCase()),
                        )
                        .map((file) => ({
                          value: file.relativePath,
                          label: file.relativePath,
                        }))}
                      onSelect={(path) => {
                        setTarget(path);
                        setTargetQuery(path);
                        setValidation(null);
                        setError(null);
                      }}
                      emptyText="No matching project files"
                    />
                    {window.catalex && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || disabled}
                        onClick={() => void chooseFile()}
                      >
                        Choose file…
                      </Button>
                    )}
                  </div>
                ) : undefined,
              icon: LinkIcon,
              disabled: selectedGroups.length !== 1,
            },
          ]}
        />
      </div>
      {action === "relink" && (
        <div className="space-y-1 px-2">
          {target && !validation && (
            <p role="status" className="text-muted-foreground text-xs">
              Checking file…
            </p>
          )}
          {validation?.key === validationKey && validation.error && (
            <p role="alert" className="text-destructive text-xs">
              {validation.error}
            </p>
          )}
          {valid && (
            <p role="status" className="text-muted-foreground text-xs">
              Ready to relink.
              {validation.result?.unplaced
                ? " Comment positions will need review."
                : ""}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <div className="flex justify-end pt-1">
        <Button
          variant={action === "clear" ? "destructive" : "default"}
          disabled={
            disabled ||
            busy ||
            !selected.length ||
            (action === "relink" && !valid) ||
            (action === "clear" && !clearable) ||
            (action === "auto-relink" && !autoRelinkable)
          }
          onClick={() => void execute()}
        >
          {busy
            ? action === "auto-relink"
              ? "Finding matches…"
              : "Applying…"
            : "Continue"}
        </Button>
      </div>
    </section>
  );
}
