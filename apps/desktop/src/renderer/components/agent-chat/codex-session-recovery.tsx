import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ChatErrorPanel } from "./chat-error-panel";
import { invoke } from "@/lib/desktop/core";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function CodexSessionRecovery({
  agentName,
  effort,
}: {
  agentName: string;
  effort: string;
}) {
  const tabId = useAgentChatStore((s) => s.activeTabId);
  const tab = useAgentChatStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId),
  );
  const sessionId = tab?.providerSessionIds.codex ?? tab?.sessionId;
  const error = tab?.error ?? "";
  const [owner, setOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setOwner(null);
    setRecoveryError(null);
    if (sessionId)
      void invoke<{ ownerToken: string } | null>("check_codex_session_owner", {
        tabId,
        sessionId,
      })
        .then((value) => {
          if (!cancelled) setOwner(value?.ownerToken ?? null);
        })
        .catch(() => {
          /* Unverified owners never get a Take over action. */
        });
    return () => {
      cancelled = true;
    };
  }, [tabId, sessionId, error]);
  const recover = async (takeover: boolean) => {
    if (!sessionId || busy) return;
    setBusy(true);
    setConfirm(false);
    setRecoveryError(null);
    const state = useAgentChatStore.getState();
    try {
      await invoke("reconnect_codex_session", {
        tabId,
        sessionId,
        ownerToken: takeover ? owner : null,
        model: state.selectedCodexModel,
        reasoningEffort: state.selectedCodexReasoningEffort,
      });
      // Do not clear a newer failure or another tab's state.
      const current = useAgentChatStore.getState();
      if (current.tabs.find((t) => t.id === tabId)?.error === error)
        current._recoverError(tabId, error);
    } catch (failure) {
      setRecoveryError(String(failure));
      const next = await invoke<{ ownerToken: string } | null>(
        "check_codex_session_owner",
        { tabId, sessionId },
      ).catch(() => null);
      setOwner(next?.ownerToken ?? null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ChatErrorPanel
        message={recoveryError ?? error}
        agentName={agentName}
        effort={effort}
        actions={[
          {
            label: sessionId ? "Reconnect" : "Dismiss",
            primary: !owner,
            disabled: busy,
            busy,
            icon: <RefreshCw className="size-3.5" />,
            onClick: () =>
              sessionId
                ? void recover(false)
                : useAgentChatStore.getState()._recoverError(tabId, error),
          },
          ...(owner
            ? [
                {
                  label: "Take over",
                  primary: true,
                  disabled: busy,
                  hint: "Stop the other session and reconnect here.",
                  onClick: () => setConfirm(true),
                },
              ]
            : []),
        ]}
      />
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Take over this session?</DialogTitle>
            <DialogDescription>
              This will interrupt the agent running in another window.
              In-progress work may be incomplete.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button onClick={() => void recover(true)}>Take over</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
