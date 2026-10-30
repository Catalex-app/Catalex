import { useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { ChatErrorPanel } from "@/components/agent-chat/chat-error-panel";
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

/** Only recovery is simulated; rendering is the production error component. */
export function ChatErrorInputPreview({
  agentName,
  effort,
  blocked,
  resolved,
  busySession = false,
}: {
  agentName: string;
  effort: string;
  blocked: boolean;
  resolved: boolean;
  busySession?: boolean;
  style?: "solid" | "inner";
}) {
  const error = useAgentChatStore((state) => state.error);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!error) return null;
  const recover = async (takeover = false) => {
    const chat = useAgentChatStore.getState();
    const tabId = chat.activeTabId;
    setBusy(true);
    await new Promise((resolve) => setTimeout(resolve, 650));
    if (
      (resolved || takeover) &&
      useAgentChatStore.getState().tabs.find((tab) => tab.id === tabId)
        ?.error === error
    )
      chat._setError(tabId, null);
    setBusy(false);
  };
  return (
    <>
      <ChatErrorPanel
        message={error}
        agentName={agentName}
        effort={effort}
        actions={[
          {
            label: "Refresh",
            primary: blocked && !busySession,
            busy,
            disabled: busy,
            icon: <RefreshCw className="size-3.5" />,
            onClick: () => void recover(),
          },
          ...(busySession
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
          ...(!blocked
            ? [
                {
                  label: "Fix with chat",
                  primary: true,
                  disabled: busy,
                  icon: <Sparkles className="size-3.5" />,
                  onClick: () => {
                    const chat = useAgentChatStore.getState();
                    chat._setError(chat.activeTabId, null);
                    void chat.sendPrompt(
                      "Please investigate and fix the problem. Preserve my manual edits and already-approved changes.\n\n" +
                        error,
                      undefined,
                      false,
                      undefined,
                      chat.activeTabId,
                    );
                  },
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
              This demo simulates a verified session owner; no real process will
              be stopped.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                void recover(true);
              }}
            >
              Take over
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
