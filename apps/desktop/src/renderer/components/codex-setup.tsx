import { PRODUCT_NAME } from "../../branding";
import { MissingInstallationCard } from "@/components/missing-installation-card";
import { useEffect } from "react";
import { listen, type UnlistenFn } from "@/lib/desktop/event";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  LoaderIcon,
  LogInIcon,
  RefreshCwIcon,
} from "lucide-react";
import { open as shellOpen } from "@/lib/desktop/shell";

import { Button } from "@/components/ui/button";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { cn } from "@/lib/utils";

function useCodexLoginEvents() {
  const isLoggingIn = useCodexSetupStore((s) => s.isLoggingIn);

  useEffect(() => {
    if (!isLoggingIn) return;

    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        useCodexSetupStore.getState()._advanceLoginStep("waiting-auth");
      }
    }, 1500);

    (async () => {
      const unlistenOutput = await listen<string>("codex-login-output", () => {
        if (!cancelled) {
          useCodexSetupStore.getState()._advanceLoginStep("waiting-auth");
        }
      });

      const unlistenComplete = await listen<boolean>(
        "codex-login-complete",
        (event) => {
          if (!cancelled) {
            clearTimeout(timer);
            useCodexSetupStore.getState()._finishLogin(event.payload);
          }
        },
      );

      if (cancelled) {
        unlistenOutput();
        unlistenComplete();
        return;
      }

      unlisteners.push(unlistenOutput, unlistenComplete);
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const unlisten of unlisteners) unlisten();
    };
  }, [isLoggingIn]);
}

function StepRow({
  label,
  status,
}: {
  label: string;
  status: "pending" | "active" | "complete" | "error";
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      {status === "complete" && (
        <CheckCircle2Icon className="size-3.5 text-green-600" />
      )}
      {status === "active" && (
        <LoaderIcon className="size-3.5 animate-spin text-foreground" />
      )}
      {status === "pending" && (
        <div className="size-3.5 rounded-full border border-muted-foreground/30" />
      )}
      {status === "error" && (
        <AlertCircleIcon className="size-3.5 text-destructive" />
      )}
      <span
        className={cn(
          "text-sm",
          status === "complete" && "text-green-600",
          status === "active" && "font-medium text-foreground",
          status === "pending" && "text-muted-foreground/60",
          status === "error" && "text-destructive",
        )}
      >
        {label}
      </span>
    </div>
  );
}

export function CodexSetup({
  checkOnMount = true,
  statusOverride,
}: {
  checkOnMount?: boolean;
  statusOverride?: ReturnType<typeof useCodexSetupStore.getState>["status"];
}) {
  const liveStatus = useCodexSetupStore((s) => s.status);
  const status = statusOverride ?? liveStatus;
  const isLoggingIn = useCodexSetupStore((s) => s.isLoggingIn);
  const error = useCodexSetupStore((s) => s.error);
  const version = useCodexSetupStore((s) => s.version);
  const accountLabel = useCodexSetupStore((s) => s.accountLabel);
  const login = useCodexSetupStore((s) => s.login);
  const checkStatus = useCodexSetupStore((s) => s.checkStatus);
  const loginSteps = useCodexSetupStore((s) => s.loginSteps);

  useCodexLoginEvents();

  useEffect(() => {
    if (checkOnMount) void checkStatus();
  }, [checkOnMount, checkStatus]);

  if (status === "checking") {
    return (
      <div className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-muted/30 px-5 py-4">
        <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground text-sm">Checking Codex…</span>
      </div>
    );
  }

  if (status === "not-installed") {
    return (
      <MissingInstallationCard
        title="Codex CLI not found"
        description="Install Codex CLI to use Codex as your AI provider."
      >
        <Button size="sm" variant="default" className="min-w-0" asChild>
          <a
            href="https://developers.openai.com/codex/cli/"
            onClick={(event) => {
              if (window.catalex) {
                event.preventDefault();
                void shellOpen("https://developers.openai.com/codex/cli/");
              }
            }}
          >
            <ExternalLinkIcon className="size-4" />
            Install Codex CLI
          </a>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="min-w-0"
          onClick={checkStatus}
        >
          <RefreshCwIcon className="size-4" />
          Recheck
        </Button>
      </MissingInstallationCard>
    );
  }

  if (status === "not-authenticated" && !isLoggingIn) {
    return (
      <MissingInstallationCard
        title="Codex CLI is signed out."
        description={
          "Sign in with ChatGPT to use Codex in " + PRODUCT_NAME + "."
        }
      >
        <Button size="sm" onClick={login}>
          <LogInIcon className="size-4" />
          Sign in
        </Button>
        <Button size="sm" variant="ghost" onClick={checkStatus}>
          <RefreshCwIcon className="size-4" />
          Recheck
        </Button>
      </MissingInstallationCard>
    );
  }

  if (status === "error") {
    return (
      <MissingInstallationCard
        tone="error"
        title="Codex CLI check failed"
        description={error || "We couldn’t check Codex. Please try again."}
      >
        <Button size="sm" onClick={checkStatus}>
          <RefreshCwIcon className="size-4" />
          Recheck
        </Button>
      </MissingInstallationCard>
    );
  }

  if (status === "not-authenticated" || isLoggingIn) {
    return (
      <div className="w-full rounded-xl border border-border bg-background p-4">
        <div className="mb-1 flex items-center gap-2">
          <LogInIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">Codex</span>
          {version && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              {version}
            </span>
          )}
        </div>
        <p className="mb-3 text-muted-foreground text-sm">
          Sign in with ChatGPT to use Codex in {PRODUCT_NAME}.
        </p>
        {loginSteps.length > 0 && (
          <div className="mb-3 space-y-1 rounded-lg border border-border bg-muted/20 p-3">
            {loginSteps.map((step) => (
              <StepRow key={step.id} label={step.label} status={step.status} />
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={login} disabled={isLoggingIn}>
            {isLoggingIn ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <LogInIcon className="size-4" />
            )}
            {isLoggingIn ? "Signing In…" : "Sign In"}
          </Button>
          <Button size="sm" variant="ghost" onClick={checkStatus}>
            <RefreshCwIcon className="size-4" />
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full items-center justify-between rounded-xl border border-border bg-background px-4 py-3">
      <div>
        <div className="flex items-center gap-2">
          <CheckCircle2Icon className="size-4 text-green-600" />
          <span className="font-medium text-sm">Codex ready</span>
        </div>
        <div className="mt-0.5 text-muted-foreground text-xs">
          {accountLabel ?? "Logged in"} {version ? `• ${version}` : ""}
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={checkStatus}>
        <RefreshCwIcon className="size-4" />
        Refresh
      </Button>
    </div>
  );
}
