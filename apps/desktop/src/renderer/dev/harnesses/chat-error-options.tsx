import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useAgentChatStore } from "@/stores/agent-chat-store";

export type ErrorOption = "a" | "b" | "c";

/** Visual comparison only: retry simulates recovery without starting a provider. */
export function ChatErrorOptions({ option }: { option: ErrorOption }) {
  const error = useAgentChatStore((state) => state.error);
  const [targets, setTargets] = useState<Element[]>([]);
  const [details, setDetails] = useState(false);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const update = () => {
      const next = [
        ...document.querySelectorAll(
          `[data-chat-feedback-slot="${option === "b" ? "inside" : "above"}"]`,
        ),
      ];
      setTargets((previous) =>
        previous.length === next.length &&
        previous.every((node, i) => node === next[i])
          ? previous
          : next,
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [option]);
  useEffect(() => {
    setDetails(false);
  }, [option]);
  useEffect(() => {
    if (!retrying) return;
    const timer = window.setTimeout(() => {
      const chat = useAgentChatStore.getState();
      chat._setError(chat.activeTabId, null);
      setRetrying(false);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [retrying]);
  if (!error) return null;
  const dismiss = () => {
    const chat = useAgentChatStore.getState();
    chat._setError(chat.activeTabId, null);
  };
  const icon = retrying ? (
    <LoaderCircle className="size-4 animate-spin" />
  ) : (
    <AlertCircle className="size-4" />
  );
  const title = retrying ? "Reconnecting…" : "Agent connection interrupted";
  const retry = (
    <button
      type="button"
      disabled={retrying}
      onClick={() => setRetrying(true)}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 font-medium text-foreground text-xs shadow-sm transition-colors hover:bg-muted disabled:opacity-50"
    >
      <RotateCcw className="size-3" />
      {retrying ? "Retrying…" : "Retry"}
    </button>
  );
  const close = (
    <button
      type="button"
      aria-label="Dismiss error preview"
      onClick={dismiss}
      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <X className="size-3.5" />
    </button>
  );
  const detailButton = (
    <button
      type="button"
      aria-expanded={details}
      onClick={() => setDetails(!details)}
      className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
    >
      {details ? "Hide details" : "Details"}
    </button>
  );
  const technical = details && (
    <p className="mt-2 border-border/60 border-t pt-2 font-mono text-[11px] text-muted-foreground leading-relaxed">
      {error}
    </p>
  );
  return (
    <>
      {targets.map((target, index) =>
        createPortal(
          <div
            data-error-design={option}
            role="status"
            className={
              option === "b"
                ? "mx-3 mt-3 border-border/70 border-b pb-2.5"
                : option === "a"
                  ? "mb-2.5 rounded-lg border border-amber-500/20 bg-amber-50/60 px-3 py-2.5 dark:bg-amber-500/5"
                  : "mb-3 px-1 py-1"
            }
          >
            {option === "a" ? (
              <>
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 text-amber-600 dark:text-amber-400">
                    {icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground text-xs">
                      {title}
                    </p>
                    <p className="mt-0.5 text-muted-foreground text-xs">
                      Your draft and feedback are saved.
                    </p>
                  </div>
                  {retry}
                  {close}
                </div>
                <div className="mt-1 pl-6.5">
                  {detailButton}
                  {technical}
                </div>
              </>
            ) : option === "b" ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-amber-600 dark:text-amber-400">
                    {icon}
                  </span>
                  <span className="flex-1 font-medium text-xs">
                    {retrying
                      ? title
                      : "Unable to continue · Connection interrupted"}
                  </span>
                  {retry}
                  {close}
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-3 pl-6 text-muted-foreground text-xs">
                  <span>Your feedback is safe. Retry to continue.</span>
                  {detailButton}
                </div>
                {technical}
              </>
            ) : (
              <div className="flex items-start gap-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
                  {icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-xs">
                      {retrying ? title : "I couldn’t continue this revision"}
                    </p>
                    {close}
                  </div>
                  <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                    The connection dropped before I could finish.
                    <br />
                    Your draft and feedback are still here.
                  </p>
                  <div className="mt-2.5 flex items-center gap-3">
                    {retry}
                    {detailButton}
                  </div>
                  {technical}
                </div>
              </div>
            )}
          </div>,
          target,
          `${option}-${index}`,
        ),
      )}
    </>
  );
}
