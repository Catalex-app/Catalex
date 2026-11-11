import {
  Undo2Icon,
  Redo2Icon,
  ScissorsIcon,
  CopyIcon,
  ClipboardPasteIcon,
  TextSelectIcon,
  ExternalLinkIcon,
  LinkIcon,
  MessageSquarePlusIcon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import {
  CONTEXT_MENU_EVENT,
  CONTEXT_MENU_DISMISS_EVENT,
  installContextMenus,
  type ContextMenuRequest,
} from "@/lib/context-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./context-menu";

const actionIcons: Record<string, LucideIcon> = {
  Undo: Undo2Icon,
  Redo: Redo2Icon,
  Cut: ScissorsIcon,
  Copy: CopyIcon,
  Paste: ClipboardPasteIcon,
  "Select All": TextSelectIcon,
  "Open Link": ExternalLinkIcon,
  "Copy Link": LinkIcon,
  "Add Comment": MessageSquarePlusIcon,
};

function ActionIcon({ label }: { label: string }) {
  const Icon = actionIcons[label];
  return Icon ? (
    <Icon aria-hidden="true" className="mr-2 size-4" />
  ) : (
    <span aria-hidden="true" className="mr-2 size-4 shrink-0" />
  );
}

/** One shared Radix menu serves text surfaces, including preview iframes. */
export function AppContextMenu() {
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);
  const [revision, setRevision] = useState(0);
  const activeRequest = useRef<ContextMenuRequest | null>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const remove = installContextMenus(document);
    const show = (event: Event) => {
      // Preview iframe events arrive here without passing through this document.
      if (
        document.querySelector(
          '[data-slot="context-menu-content"][data-state="open"]',
        )
      )
        return;
      const next = (event as CustomEvent<ContextMenuRequest>).detail;
      activeRequest.current = next;
      flushSync(() => {
        setRequest(next);
        setRevision((value) => value + 1);
      });
      if (next.actions.length)
        trigger.current?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: next.x,
            clientY: next.y,
          }),
        );
      if (next.loadActions) {
        void next
          .loadActions()
          .then((actions) => {
            if (activeRequest.current === next)
              setRequest({ ...next, actions });
          })
          .catch(() => {
            if (activeRequest.current === next)
              setRequest({
                ...next,
                actions: next.actions.map((action) =>
                  action.label === "Checking spelling…"
                    ? { ...action, label: "Spelling suggestions unavailable" }
                    : action,
                ),
              });
          });
      }
    };
    const dismiss = () => {
      activeRequest.current = null;
      setRevision((value) => value + 1);
    };
    window.addEventListener(CONTEXT_MENU_EVENT, show);
    window.addEventListener(CONTEXT_MENU_DISMISS_EVENT, dismiss);
    return () => {
      activeRequest.current = null;
      remove();
      window.removeEventListener(CONTEXT_MENU_EVENT, show);
      window.removeEventListener(CONTEXT_MENU_DISMISS_EVENT, dismiss);
    };
  }, []);
  return (
    <ContextMenu
      key={revision}
      modal={false}
      onOpenChange={(open) => {
        if (!open) activeRequest.current = null;
      }}
    >
      <ContextMenuTrigger asChild>
        <span
          ref={trigger}
          aria-hidden="true"
          className="pointer-events-none fixed size-0"
        />
      </ContextMenuTrigger>
      <ContextMenuContent
        portalContainer={request?.portalContainer}
        className="min-w-44 data-[state=closed]:pointer-events-none"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        onEscapeKeyDown={() => request?.restoreFocus()}
      >
        {request?.actions.map((action) => (
          <Fragment key={action.label}>
            {action.separator && <ContextMenuSeparator />}
            <ContextMenuItem
              disabled={action.disabled}
              onSelect={() => {
                Promise.resolve()
                  .then(action.run)
                  .catch((error: unknown) => {
                    toast.error(`${action.label} failed`, {
                      description: String(error),
                    });
                  });
              }}
            >
              <ActionIcon label={action.label} />
              {action.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
