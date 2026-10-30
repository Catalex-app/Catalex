import { Hint } from "@/components/ui/tooltip";
import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc, invoke } from "@/lib/desktop/core";
import {
  AppWindowIcon,
  ChevronDownIcon,
  FileCodeIcon,
  FolderIcon,
  MousePointerClickIcon,
  SparklesIcon,
  TerminalIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useDocumentStore } from "@/stores/document-store";

export interface EditorInfo {
  id: string;
  name: string;
  iconPath?: string | null;
  iconDataUrl?: string | null;
}

const LAST_EDITOR_STORAGE_KEY = "catalex.last-external-editor-id";
const DEFAULT_EDITOR_ID = "finder";
const EDITOR_NAME_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: "base",
});

export function getDefaultExternalEditorId(editors: EditorInfo[]) {
  return (
    editors.find((editor) => editor.id === DEFAULT_EDITOR_ID)?.id ??
    editors[0]?.id ??
    null
  );
}

export function sortExternalEditorsByName(editors: EditorInfo[]) {
  return [...editors].sort(
    (a, b) =>
      EDITOR_NAME_COLLATOR.compare(a.name, b.name) || a.id.localeCompare(b.id),
  );
}

function getFallbackEditorIcon(editorId: string, className?: string) {
  const iconClass = cn("size-4 shrink-0", className);
  switch (editorId) {
    case "cursor":
      return <MousePointerClickIcon className={iconClass} />;
    case "vscode":
      return <FileCodeIcon className={iconClass} />;
    case "zed":
      return <ZapIcon className={iconClass} />;
    case "sublime":
      return <SparklesIcon className={iconClass} />;
    case "finder":
      return <FolderIcon className={iconClass} />;
    case "ghostty":
    case "iterm2":
    case "kitty":
    case "antigravity":
      return <TerminalIcon className={iconClass} />;
    default:
      return <AppWindowIcon className={iconClass} />;
  }
}

function EditorAppIcon({
  editor,
  className,
}: {
  editor: EditorInfo;
  className?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const src =
    editor.iconDataUrl ||
    (editor.iconPath ? convertFileSrc(editor.iconPath) : null);

  useEffect(() => {
    setImgFailed(false);
  }, [editor.id, editor.iconDataUrl, editor.iconPath]);

  if (src && !imgFailed) {
    return (
      <img
        src={src}
        alt=""
        className={cn("size-4 shrink-0 rounded-sm object-contain", className)}
        onError={() => setImgFailed(true)}
      />
    );
  }
  return getFallbackEditorIcon(editor.id, className);
}

interface ExternalAppSelectorProps {
  size?: "regular" | "compact";
}

export function ExternalAppSelector({
  size = "compact",
}: ExternalAppSelectorProps) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [lastEditorId, setLastEditorId] = useState<string | null>(null);
  const sortedEditors = useMemo(
    () => sortExternalEditorsByName(editors),
    [editors],
  );
  const defaultEditorId = useMemo(
    () => getDefaultExternalEditorId(editors),
    [editors],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(LAST_EDITOR_STORAGE_KEY);
    if (stored) setLastEditorId(stored);
  }, []);

  useEffect(() => {
    invoke<EditorInfo[]>("detect_editors")
      .then(setEditors)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (editors.length === 0) return;
    const preferred =
      lastEditorId && editors.some((editor) => editor.id === lastEditorId)
        ? lastEditorId
        : defaultEditorId;
    if (!preferred) return;
    if (preferred !== lastEditorId) {
      setLastEditorId(preferred);
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LAST_EDITOR_STORAGE_KEY, preferred);
    }
  }, [defaultEditorId, editors, lastEditorId]);

  const setPreferredEditor = useCallback((editorId: string) => {
    setLastEditorId(editorId);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LAST_EDITOR_STORAGE_KEY, editorId);
    }
  }, []);

  const openProjectInEditor = useCallback(
    (editorId: string) => {
      if (!projectRoot) return;
      invoke("open_in_editor", {
        editorId,
        projectPath: projectRoot,
      }).catch((err) => console.error("open_in_editor failed:", err));
    },
    [projectRoot],
  );

  const preferredEditor =
    editors.find((editor) => editor.id === lastEditorId) ??
    editors.find((editor) => editor.id === defaultEditorId) ??
    sortedEditors[0];
  if (!projectRoot || editors.length === 0 || !preferredEditor) return null;

  const compact = size === "compact";

  return (
    <DropdownMenu>
      <div
        className={cn(
          "external-app-selector inline-flex items-center overflow-hidden rounded-lg border border-border/60 bg-muted/50",
          compact ? "h-6" : "h-8",
        )}
      >
        <Hint content={`Open in ${preferredEditor.name}`}>
          <Button
            variant="ghost"
            size={compact ? "icon-xs" : "icon-sm"}
            className={cn(
              "rounded-r-sm rounded-l-lg border-0 p-0",
              compact ? "h-6 w-6" : "h-8 w-8",
            )}
            aria-label={`Open in ${preferredEditor.name}`}
            onClick={() => {
              setPreferredEditor(preferredEditor.id);
              openProjectInEditor(preferredEditor.id);
            }}
          >
            <EditorAppIcon
              editor={preferredEditor}
              className={compact ? "size-4" : "size-[22px]"}
            />
          </Button>
        </Hint>
        <Hint
          content={
            editors.length > 1
              ? "Choose editor app"
              : "Only one editor app detected"
          }
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size={compact ? "icon-xs" : "icon-sm"}
              className={cn(
                "rounded-r-lg rounded-l-sm p-0",
                compact ? "h-6 w-4" : "h-8 w-5",
              )}
              aria-label={
                editors.length > 1
                  ? "Choose editor app"
                  : "Only one editor app detected"
              }
              disabled={editors.length <= 1}
            >
              <ChevronDownIcon className={compact ? "size-3" : "size-3.5"} />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
      </div>
      <DropdownMenuContent
        align="start"
        alignOffset={compact ? -24 : -32}
        className="w-48"
      >
        <DropdownMenuLabel>
          <span className="inline-flex items-center gap-1.5">
            <AppWindowIcon className="size-3.5 text-muted-foreground" />
            <span>Open In</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="mx-2" />
        {sortedEditors.map((editor) => (
          <DropdownMenuItem
            key={editor.id}
            onClick={() => {
              setPreferredEditor(editor.id);
              openProjectInEditor(editor.id);
            }}
          >
            <EditorAppIcon editor={editor} className="size-[22px]" />
            <span className="min-w-0 flex-1 truncate">{editor.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
