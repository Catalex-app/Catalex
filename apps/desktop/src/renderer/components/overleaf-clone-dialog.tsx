import { PRODUCT_NAME } from "../../branding";
import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@/lib/desktop/core";
import { homeDir, join } from "@/lib/desktop/path";
import { open } from "@/lib/desktop/dialog";
import { FolderOpenIcon, LeafIcon, Loader2Icon, XIcon } from "lucide-react";
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
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";

interface OverleafCloneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CLONE_COMMAND_PLACEHOLDER = "git clone https://git@git.overleaf.com/....";

function overleafProjectName(cloneCommand: string): string | null {
  const parts = cloneCommand.trim().split(/\s+/);
  if (parts.length !== 3 || parts[0] !== "git" || parts[1] !== "clone") {
    return null;
  }

  try {
    const cloneUrl = new URL(parts[2]);
    if (
      cloneUrl.protocol !== "https:" ||
      cloneUrl.hostname !== "git.overleaf.com" ||
      (cloneUrl.username && cloneUrl.username !== "git") ||
      cloneUrl.password ||
      cloneUrl.search ||
      cloneUrl.hash
    ) {
      return null;
    }

    const encodedName = cloneUrl.pathname.replace(/\/+$/, "").split("/").pop();
    if (!encodedName) return null;
    const name = decodeURIComponent(encodedName).replace(/\.git$/, "");
    return /^[A-Za-z0-9._-]+$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

function displayClonePath(localPath: string, projectName: string | null) {
  const base = localPath.trim().replace(/[\\/]+$/, "");
  if (!base || !projectName) return "";
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base}${separator}${projectName}`;
}

function isValidLocalName(localName: string) {
  const name = localName.trim();
  return Boolean(name && name !== "." && name !== ".." && !/[\\/]/.test(name));
}

function formatError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "The Overleaf project could not be cloned.";
}

export function OverleafCloneDialog({
  open: isOpen,
  onOpenChange,
}: OverleafCloneDialogProps) {
  const [cloneCommand, setCloneCommand] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [localName, setLocalName] = useState("");
  const [localNameEdited, setLocalNameEdited] = useState(false);
  const [localPath, setLocalPath] = useState("");
  const [isResolvingPath, setIsResolvingPath] = useState(false);
  const [isDetectingToken, setIsDetectingToken] = useState(false);
  const [detectedToken, setDetectedToken] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
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
    setCloneCommand("");
    setAccessToken("");
    setLocalName("");
    setLocalNameEdited(false);
    setDetectedToken(false);
    setError(null);
    setIsResolvingPath(true);
    setIsDetectingToken(true);

    const resolveDefaultPath = async () => {
      try {
        const resolvedHome = lastProjectFolder ? null : await homeDir();
        const defaultLocalPath = lastProjectFolder
          ? lastProjectFolder
          : typeof resolvedHome === "string"
            ? await join(resolvedHome, "Documents", PRODUCT_NAME)
            : null;
        if (!cancelled) setLocalPath(defaultLocalPath ?? "");
      } catch (pathError) {
        console.warn("Failed to resolve the default clone path:", pathError);
        if (!cancelled) setLocalPath("");
      } finally {
        if (!cancelled) setIsResolvingPath(false);
      }
    };

    const detectToken = async () => {
      try {
        const token = await invoke<string | null>("git_overleaf_token_detect");
        if (!cancelled && token) {
          setAccessToken((current) => current || token);
          setDetectedToken(true);
        }
      } catch (tokenError) {
        console.warn(
          "Failed to detect an existing Overleaf token:",
          tokenError,
        );
      } finally {
        if (!cancelled) setIsDetectingToken(false);
      }
    };

    void resolveDefaultPath();
    void detectToken();
    return () => {
      cancelled = true;
    };
  }, [isOpen, lastProjectFolder]);

  const overleafProjectId = useMemo(
    () => overleafProjectName(cloneCommand),
    [cloneCommand],
  );
  const validLocalName = isValidLocalName(localName);
  const clonePath = displayClonePath(
    localPath,
    validLocalName ? localName.trim() : null,
  );

  const handleChooseFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose Clone Location",
    });
    if (typeof selected === "string") {
      setLocalPath(selected);
      setError(null);
    }
  }, []);

  const handleClone = useCallback(async () => {
    const nextCommand = cloneCommand.trim();
    const nextToken = accessToken.trim();
    const nextLocalName = localName.trim();
    const nextLocalPath = localPath.trim().replace(/[\\/]+$/, "");
    if (
      !nextCommand ||
      !nextToken ||
      !nextLocalPath ||
      !overleafProjectId ||
      !isValidLocalName(nextLocalName) ||
      isCloning
    ) {
      return;
    }

    setIsCloning(true);
    setError(null);
    try {
      const result = await invoke<{
        projectPath: string;
        credentialWarning: string | null;
      }>("git_overleaf_clone", {
        cloneCommand: nextCommand,
        accessToken: nextToken,
        localName: nextLocalName,
        localPath: nextLocalPath,
      });
      const { projectPath, credentialWarning } = result;
      if (credentialWarning)
        toast.warning(credentialWarning, { duration: 10000 });
      setLastProjectFolder(nextLocalPath);
      addRecentProject(projectPath);
      await openProject(projectPath);
      onOpenChange(false);
    } catch (cloneError) {
      console.error("Failed to clone Overleaf project:", cloneError);
      setError(formatError(cloneError));
    } finally {
      setIsCloning(false);
    }
  }, [
    accessToken,
    addRecentProject,
    cloneCommand,
    isCloning,
    localName,
    localPath,
    onOpenChange,
    openProject,
    overleafProjectId,
    setLastProjectFolder,
  ]);

  const canClone =
    Boolean(overleafProjectId) &&
    accessToken.trim().length > 0 &&
    validLocalName &&
    localPath.trim().length > 0 &&
    !isResolvingPath;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-5 rounded-[20px] bg-muted p-4 shadow-2xl sm:max-w-[420px] dark:bg-background"
        overlayClassName="bg-black/10"
        showCloseButton={false}
        data-testid="overleaf-clone-dialog"
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="inline-flex w-fit items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 py-1.5 dark:bg-muted">
              <LeafIcon className="size-6 text-muted-foreground" />
              <span className="font-medium text-foreground text-sm">
                Import from Overleaf
              </span>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Close"
                className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground transition-colors hover:text-foreground dark:bg-muted"
                disabled={isCloning}
              >
                <XIcon className="size-4" />
              </button>
            </DialogClose>
          </div>
          <DialogTitle className="sr-only">Import from Overleaf</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-3">
            <label
              htmlFor="overleaf-clone-command"
              className="font-semibold text-foreground text-sm"
            >
              Git Clone Command
            </label>
            <Input
              id="overleaf-clone-command"
              value={cloneCommand}
              onChange={(event) => {
                const nextCommand = event.target.value;
                setCloneCommand(nextCommand);
                if (!localNameEdited) {
                  setLocalName(overleafProjectName(nextCommand) ?? "");
                }
                setError(null);
              }}
              placeholder={CLONE_COMMAND_PLACEHOLDER}
              className="rounded-lg bg-background font-mono text-xs shadow-none focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-0 dark:bg-muted"
              disabled={isCloning}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="overleaf-access-token"
                className="font-semibold text-foreground text-sm"
              >
                Access Token
              </label>
              {detectedToken ? (
                <span className="text-[11px] text-muted-foreground">
                  Existing token found
                </span>
              ) : null}
            </div>
            <Input
              id="overleaf-access-token"
              type="password"
              value={accessToken}
              onChange={(event) => {
                setAccessToken(event.target.value);
                setDetectedToken(false);
                setError(null);
              }}
              placeholder={
                isDetectingToken
                  ? "Checking Git credentials..."
                  : "Paste your Overleaf access token"
              }
              className="rounded-lg bg-background font-mono text-xs shadow-none focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-0 dark:bg-muted"
              disabled={isCloning}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="space-y-3">
            <label
              htmlFor="overleaf-local-name"
              className="font-semibold text-foreground text-sm"
            >
              Local Name
            </label>
            <Input
              id="overleaf-local-name"
              value={localName}
              onChange={(event) => {
                setLocalName(event.target.value);
                setLocalNameEdited(true);
                setError(null);
              }}
              placeholder="Project name"
              className="rounded-lg bg-background shadow-none focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-0 dark:bg-muted"
              disabled={isCloning}
            />
          </div>

          <div className="space-y-3">
            <label
              htmlFor="overleaf-local-path"
              className="font-semibold text-foreground text-sm"
            >
              Local Path
            </label>
            <div className="flex gap-3">
              <Input
                id="overleaf-local-path"
                value={localPath}
                onChange={(event) => {
                  setLocalPath(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canClone) {
                    event.preventDefault();
                    void handleClone();
                  }
                }}
                placeholder={
                  isResolvingPath
                    ? "Choosing a default location..."
                    : "/path/to/projects"
                }
                className="min-w-0 flex-1 rounded-lg bg-background font-mono text-xs shadow-none focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-0 dark:bg-muted"
                disabled={isCloning}
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0 gap-1.5 rounded-lg bg-background shadow-none dark:bg-muted"
                onClick={() => void handleChooseFolder()}
                disabled={isCloning}
              >
                <FolderOpenIcon className="size-3.5" />
                Choose
              </Button>
            </div>
          </div>

          {cloneCommand.trim() && !overleafProjectId ? (
            <p className="text-destructive text-xs" role="alert">
              Paste an Overleaf command in the form “git clone
              https://git@git.overleaf.com/PROJECT_ID”.
            </p>
          ) : localName.trim() && !validLocalName ? (
            <p className="text-destructive text-xs" role="alert">
              Local name cannot contain path separators.
            </p>
          ) : error ? (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <p className="min-w-0 text-muted-foreground text-xs">
          The project will be cloned to{" "}
          <span className="break-words font-mono text-foreground/80">
            {clonePath || "—"}
          </span>
        </p>

        <DialogFooter>
          <Button
            type="button"
            className="rounded-lg"
            onClick={() => void handleClone()}
            disabled={!canClone || isCloning}
          >
            {isCloning ? (
              <>
                <Loader2Icon className="size-4 animate-spin" />
                Cloning...
              </>
            ) : (
              "Clone Project"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
