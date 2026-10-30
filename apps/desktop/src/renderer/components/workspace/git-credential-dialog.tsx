import { useState } from "react";
import { RefreshCwIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GitCommandDisclosure } from "@/components/workspace/git-command-disclosure";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogIconHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface GitCredentialRequest {
  id: string;
  projectRoot: string;
  host: string;
  provider: string;
  username: string;
  action: string;
  remoteBranch: string | null;
  commands: string[];
}

export function GitCredentialDialog({
  request,
  onSubmit,
  onCancel,
}: {
  request: GitCredentialRequest;
  onSubmit: (username: string, token: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [token, setToken] = useState("");
  const [username, setUsername] = useState(request.username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showGitCommand, setShowGitCommand] = useState(false);
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(username, token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) onCancel();
      }}
    >
      <DialogContent
        className="gap-5 rounded-[20px] bg-muted p-4 shadow-2xl dark:bg-background"
        overlayClassName="bg-black/10"
        showCloseButton={false}
        aria-describedby="credential-heading"
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="space-y-3">
          <DialogIconHeader closeDisabled={busy}>
            <RefreshCwIcon
              className="shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <DialogTitle className="font-medium text-sm">
              Update credentials
            </DialogTitle>
          </DialogIconHeader>
          <h2
            id="credential-heading"
            className="font-semibold text-base leading-snug"
          >
            Your {request.provider} credentials may be missing, expired, or
            invalid
          </h2>
        </DialogHeader>
        <section
          aria-labelledby="connection-details-title"
          className="space-y-3"
        >
          <h2 id="connection-details-title" className="font-semibold text-sm">
            Connection details
          </h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Server</dt>
            <dd className="break-all">{request.host}</dd>
            <dt className="text-muted-foreground">Action</dt>
            <dd>{request.action}</dd>
            {request.remoteBranch && (
              <>
                <dt className="text-muted-foreground">Remote branch</dt>
                <dd className="break-all">{request.remoteBranch}</dd>
              </>
            )}
          </dl>
        </section>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim() && username.trim() && !busy) void retry();
          }}
        >
          {request.provider !== "Overleaf" && (
            <div className="space-y-3">
              <label
                htmlFor="credential-username"
                className="font-semibold text-sm"
              >
                Username
              </label>
              <Input
                id="credential-username"
                readOnly={!!request.username}
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setError(null);
                }}
                autoComplete="off"
                disabled={busy}
                placeholder="Your Git username"
                className="rounded-lg bg-background shadow-none dark:bg-muted"
              />
            </div>
          )}
          <div className="space-y-3">
            <label htmlFor="credential-token" className="font-semibold text-sm">
              Access token
            </label>
            <Input
              id="credential-token"
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setError(null);
              }}
              placeholder="Paste your access token"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              autoFocus
              aria-invalid={!!error}
              aria-describedby={error ? "credential-error" : undefined}
              className="rounded-lg bg-background font-mono text-xs shadow-none focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-0 dark:bg-muted"
            />
          </div>
          {error && (
            <p
              id="credential-error"
              role="alert"
              className="text-destructive text-xs leading-relaxed"
            >
              {error}
            </p>
          )}
          <GitCommandDisclosure
            commands={request.commands}
            expanded={showGitCommand}
            onExpandedChange={setShowGitCommand}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="rounded-lg"
              disabled={busy}
              onClick={() => {
                onCancel();
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="gap-2 rounded-lg"
              disabled={busy || !token.trim() || !username.trim()}
            >
              {busy ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" />
                  Retrying…
                </>
              ) : (
                "Save and retry"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
