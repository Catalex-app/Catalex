import { useEffect, useState, type ReactNode } from "react";
import { CircleAlert, Copy, Check, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";

export interface ChatErrorAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  hint?: string;
}

/** Shared production and demo error content, inside the normal composer shell. */
export function ChatErrorPanel({
  message,
  agentName,
  effort,
  actions,
  guidance,
  neutral = false,
}: {
  message: string;
  agentName: string;
  effort: string;
  actions: ChatErrorAction[];
  guidance?: ReactNode;
  neutral?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [message]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div
      data-chat-error-composer
      role={neutral ? "status" : "alert"}
      className={`flex min-h-0 w-full flex-col ${neutral ? "text-foreground" : "text-white"}`}
    >
      <div className="flex max-h-48 min-h-10 items-start gap-2 overflow-y-auto px-3 py-2 text-sm leading-relaxed">
        <CircleAlert aria-hidden="true" className="mt-1 size-4 shrink-0" />
        <div className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words">
          <span>{message}</span>
          {guidance}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-2 pb-2">
        <span className="flex items-center gap-1.5 px-1 py-1 text-xs">
          <span>{agentName}</span>
          <span>{effort}</span>
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!neutral && (
            <Hint content={copied ? "Copied" : "Copy error"}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={copied ? "Error copied" : "Copy error"}
                className="text-white hover:bg-white/15 hover:text-white dark:hover:bg-white/15"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(message)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false))
                }
              >
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            </Hint>
          )}
          {actions.map((action) => {
            const button = (
              <Button
                key={action.label}
                type="button"
                size="sm"
                variant="ghost"
                disabled={action.disabled || action.busy}
                onClick={action.onClick}
                className={
                  neutral
                    ? "h-7 bg-foreground text-background text-xs hover:bg-foreground/90 hover:text-background"
                    : action.primary
                      ? "h-7 bg-white text-[#cf454b] text-xs hover:bg-white/90 hover:text-[#cf454b] dark:hover:bg-white/90"
                      : "h-7 border border-white/60 text-white text-xs hover:bg-white/15 hover:text-white dark:hover:bg-white/15"
                }
              >
                {action.busy ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  action.icon
                )}
                {action.label}
              </Button>
            );
            return action.hint ? (
              <Hint key={action.label} content={action.hint}>
                {button}
              </Hint>
            ) : (
              button
            );
          })}
        </div>
      </div>
    </div>
  );
}
