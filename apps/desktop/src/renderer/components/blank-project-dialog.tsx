import { PRODUCT_NAME } from "../../branding";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/desktop/core";
import { homeDir, join } from "@/lib/desktop/path";
import { open } from "@/lib/desktop/dialog";
import { exists, mkdir, writeTextFile } from "@/lib/desktop/fs";
import {
  CheckIcon,
  FileTextIcon,
  FolderOpenIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getTemplateById, getTemplateSkeleton } from "@/lib/template-registry";
import { cn } from "@/lib/utils";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";

interface BlankProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function defaultProjectName(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `New Project ${year}${month}${day}`;
}

function displayRepoPath(localPath: string, projectName: string): string {
  const base = localPath.trim().replace(/[\\/]+$/, "");
  const name = projectName.trim();
  if (!base || !name) return "";
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base}${separator}${name}`;
}

function formatError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "The project could not be created.";
}

export function BlankProjectDialog({
  open: isOpen,
  onOpenChange,
}: BlankProjectDialogProps) {
  const [projectName, setProjectName] = useState(defaultProjectName);
  const [localPath, setLocalPath] = useState("");
  const [initializeGit, setInitializeGit] = useState(true);
  const [isResolvingPath, setIsResolvingPath] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenRef = useRef(false);

  const lastProjectFolder = useProjectStore((state) => state.lastProjectFolder);
  const setLastProjectFolder = useProjectStore(
    (state) => state.setLastProjectFolder,
  );
  const addRecentProject = useProjectStore((state) => state.addRecentProject);
  const openProject = useDocumentStore((state) => state.openProject);

  useEffect(() => {
    const isOpening = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!isOpening) return;

    let cancelled = false;
    setProjectName(defaultProjectName());
    setInitializeGit(true);
    setError(null);
    setIsResolvingPath(true);

    const resolveDefaultPath = async () => {
      try {
        const resolvedHome = lastProjectFolder ? null : await homeDir();
        const defaultLocalPath = lastProjectFolder
          ? lastProjectFolder
          : typeof resolvedHome === "string"
            ? await join(resolvedHome, "Documents", PRODUCT_NAME)
            : null;
        if (typeof defaultLocalPath !== "string") {
          if (!cancelled) setLocalPath("");
          return;
        }
        if (!cancelled) setLocalPath(defaultLocalPath);
      } catch (pathError) {
        console.warn("Failed to resolve the default project path:", pathError);
        if (!cancelled) setLocalPath("");
      } finally {
        if (!cancelled) setIsResolvingPath(false);
      }
    };

    void resolveDefaultPath();
    return () => {
      cancelled = true;
    };
  }, [isOpen, lastProjectFolder]);

  const handleChooseFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose Project Location",
    });
    if (typeof selected === "string") {
      setLocalPath(selected);
      setError(null);
    }
  }, []);

  const handleCreate = useCallback(async () => {
    const nextProjectName = projectName.trim();
    const nextLocalPath = localPath.trim().replace(/[\\/]+$/, "");
    if (!nextProjectName || !nextLocalPath || isCreating) return;
    if (
      nextProjectName === "." ||
      nextProjectName === ".." ||
      /[\\/]/.test(nextProjectName)
    ) {
      setError("Project name cannot contain path separators.");
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const nextProjectPath = await join(nextLocalPath, nextProjectName);
      await mkdir(nextProjectPath, { recursive: true });
      const mainTexPath = await join(nextProjectPath, "main.tex");
      if (await exists(mainTexPath)) {
        throw new Error("A main.tex file already exists at this location.");
      }

      if (initializeGit) {
        await invoke("git_project_init", { projectRoot: nextProjectPath });
      }

      const blankTemplate = getTemplateById("blank");
      if (!blankTemplate)
        throw new Error("The blank document template is unavailable.");
      await writeTextFile(mainTexPath, getTemplateSkeleton(blankTemplate));

      setLastProjectFolder(nextLocalPath);
      addRecentProject(nextProjectPath);
      await openProject(nextProjectPath);
      onOpenChange(false);
    } catch (creationError) {
      console.error("Failed to create blank project:", creationError);
      setError(formatError(creationError));
    } finally {
      setIsCreating(false);
    }
  }, [
    addRecentProject,
    initializeGit,
    isCreating,
    onOpenChange,
    openProject,
    localPath,
    projectName,
    setLastProjectFolder,
  ]);

  const canCreate =
    projectName.trim().length > 0 &&
    localPath.trim().length > 0 &&
    !isResolvingPath;
  const repoPath = displayRepoPath(localPath, projectName);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-5 rounded-[20px] bg-muted p-4 shadow-2xl sm:max-w-[420px] dark:bg-background"
        overlayClassName="bg-black/10"
        showCloseButton={false}
        data-testid="blank-project-dialog"
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="inline-flex w-fit items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 py-1.5 dark:bg-muted">
              <FileTextIcon className="size-6 text-muted-foreground" />
              <span className="font-medium text-foreground text-sm">
                Blank Document
              </span>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Close"
                className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground transition-colors hover:text-foreground dark:bg-muted"
                disabled={isCreating}
              >
                <XIcon className="size-4" />
              </button>
            </DialogClose>
          </div>
          <DialogTitle className="sr-only">Blank project</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-4">
            <label
              htmlFor="blank-project-name"
              className="font-semibold text-foreground text-sm"
            >
              Name
            </label>
            <Input
              id="blank-project-name"
              value={projectName}
              onChange={(event) => {
                setProjectName(event.target.value);
                setError(null);
              }}
              placeholder="New Project"
              className="rounded-lg bg-background shadow-none focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-0 dark:bg-muted"
              disabled={isCreating}
              autoFocus
            />
          </div>
          <div className="space-y-3">
            <label
              htmlFor="blank-project-local-path"
              className="font-semibold text-foreground text-sm"
            >
              Local Path
            </label>
            <div className="flex gap-3">
              <Input
                id="blank-project-local-path"
                value={localPath}
                onChange={(event) => {
                  setLocalPath(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canCreate) {
                    event.preventDefault();
                    void handleCreate();
                  }
                }}
                placeholder={
                  isResolvingPath
                    ? "Choosing a default location..."
                    : "/path/to/project"
                }
                className="min-w-0 flex-1 rounded-lg bg-background font-mono text-xs shadow-none focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-0 dark:bg-muted"
                disabled={isCreating}
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0 gap-1.5 rounded-lg bg-background shadow-none dark:bg-muted"
                onClick={() => void handleChooseFolder()}
                disabled={isCreating}
              >
                <FolderOpenIcon className="size-3.5" />
                Choose
              </Button>
            </div>
          </div>
          {error ? (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <p className="min-w-0 text-muted-foreground text-xs">
          The project will be created at{" "}
          <span className="break-all font-mono text-foreground/80">
            {repoPath || "—"}
          </span>
        </p>

        <DialogFooter className="gap-3 sm:items-center sm:justify-between">
          <button
            type="button"
            role="checkbox"
            aria-checked={initializeGit}
            onClick={() => setInitializeGit((value) => !value)}
            className="flex items-center gap-2 rounded-md py-1 text-sm transition-colors hover:bg-muted/35"
            disabled={isCreating}
          >
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                initializeGit
                  ? "border-foreground bg-foreground text-background"
                  : "border-sidebar-border bg-background",
              )}
            >
              {initializeGit ? <CheckIcon className="size-3" /> : null}
            </span>
            <span>Initialize Git</span>
          </button>
          <Button
            type="button"
            className="rounded-lg"
            onClick={() => void handleCreate()}
            disabled={!canCreate || isCreating}
          >
            {isCreating ? (
              <>
                <Loader2Icon className="size-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Project"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
