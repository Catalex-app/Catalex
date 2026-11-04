import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithRef,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { PanelResizeHandle } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import { canHandleEscape } from "@/lib/keyboard-events";
import {
  usePanelExpansionMotion,
  type PanelExpansionMotion,
} from "./use-panel-expansion-motion";
import "./workspace-panel.css";

export interface WorkspacePanelExpansion {
  label: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  disabled?: boolean;
}
const ExpansionContext = createContext<WorkspacePanelExpansion | undefined>(
  undefined,
);

const MotionContext = createContext<PanelExpansionMotion | undefined>(
  undefined,
);

export function useWorkspacePanelMotion() {
  return useContext(MotionContext);
}

export function useWorkspacePanelExpansion() {
  return useContext(ExpansionContext);
}

/** Keep the live pane mounted while lifting it above the workspace. */
export function WorkspacePanel({
  className,
  expansion,
  ref,
  children,
  ...props
}: ComponentPropsWithRef<"div"> & { expansion?: WorkspacePanelExpansion }) {
  const inheritedExpansion = useContext(ExpansionContext);
  const inheritedMotion = useContext(MotionContext);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const backgroundRef = useRef<HTMLElement[]>([]);
  const onExpandedChangeRef = useRef(expansion?.onExpandedChange);
  onExpandedChangeRef.current = expansion?.onExpandedChange;
  const expanded = expansion?.expanded ?? false;
  const motion = usePanelExpansionMotion(panelRef, expanded);
  const floating = motion.floating;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!floating || !panel) return;
    const previousFocus = document.activeElement;
    const ancestors: HTMLElement[] = [];
    const siblings: Array<[HTMLElement, boolean]> = [];
    // Fixed positioning must escape the split panes' clipping/animation layers.
    for (
      let branch: HTMLElement = panel;
      branch.parentElement && branch.parentElement !== document.body;
    ) {
      const parent = branch.parentElement;
      ancestors.push(parent);
      parent.setAttribute("data-expanded-panel-ancestor", "");
      for (const sibling of parent.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          siblings.push([sibling, sibling.inert]);
          sibling.inert = true;
        }
      }
      branch = parent;
    }
    const background = siblings.map(([element]) => element);
    backgroundRef.current = background;
    const measureBackground = () => {
      // These disjoint branches share one viewport-centered scale. Scaling an
      // ancestor instead would also shrink/trap the live fullscreen panel.
      for (const element of background)
        element.removeAttribute("data-workspace-panel-background");
      const bounds = background.map((element) =>
        element.getBoundingClientRect(),
      );
      for (const [index, element] of background.entries()) {
        const rect = bounds[index];
        element.style.setProperty(
          "--panel-background-origin",
          `${window.innerWidth / 2 - rect.left}px ${window.innerHeight / 2 - rect.top}px`,
        );
        element.setAttribute("data-workspace-panel-background", "");
      }
    };
    measureBackground();
    window.addEventListener("resize", measureBackground);
    const restoreButton = panel.querySelector<HTMLButtonElement>(
      "[data-panel-expand-control]",
    );
    restoreButton?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      // Menus, dialogs and editor search get the first chance to handle Escape.
      if (event.defaultPrevented) return;
      const target = event.target;
      if (
        !(target instanceof Node) ||
        (!panel.contains(target) && target !== document.body)
      )
        return;
      if (canHandleEscape(event)) {
        event.preventDefault();
        event.stopPropagation();
        onExpandedChangeRef.current?.(false);
      }
      if (event.key === "Tab") {
        const focusable = Array.from(
          panel.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, iframe, [tabindex], [contenteditable="true"]',
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.closest('[inert], [disabled], [aria-hidden="true"]') &&
            element.getClientRects().length > 0,
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && target === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && target === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    // Portalled editor popups listen on document; give them first refusal.
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("resize", measureBackground);
      backgroundRef.current = [];
      for (const element of background) {
        element.removeAttribute("data-workspace-panel-background");
        element.style.removeProperty("--panel-background-origin");
        element.style.removeProperty("--panel-background-scale");
      }
      window.removeEventListener("keydown", keydown);
      for (const ancestor of ancestors)
        ancestor.removeAttribute("data-expanded-panel-ancestor");
      for (const [sibling, inert] of siblings) sibling.inert = inert;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [floating]);

  useLayoutEffect(() => {
    // Bring the background's top edge just behind the panel's 36px top inset.
    // Native traffic lights are outside the renderer and remain stationary.
    const scale = 1 - (72 / Math.max(1, window.innerHeight)) * motion.shade;
    for (const element of backgroundRef.current)
      element.style.setProperty("--panel-background-scale", String(scale));
  }, [floating, motion]);

  return (
    <ExpansionContext.Provider value={expansion ?? inheritedExpansion}>
      <MotionContext.Provider value={expansion ? motion : inheritedMotion}>
        {floating &&
          createPortal(
            <div
              data-workspace-panel-backdrop=""
              role="presentation"
              onPointerDown={(event) => event.preventDefault()}
              className="fixed inset-0 z-30 bg-white/55 dark:bg-black/40"
              style={{ opacity: motion.shade }}
            />,
            document.body,
          )}
        <div
          {...props}
          ref={(element) => {
            panelRef.current = element;
            if (typeof ref === "function") return ref(element);
            if (ref) ref.current = element;
          }}
          data-expanded-workspace-panel={
            floating ? expansion?.label : undefined
          }
          data-panel-expansion-motion={
            motion.animating ? (expanded ? "entering" : "exiting") : undefined
          }
          style={
            {
              ...props.style,
              "--expanded-panel-elevation": motion.shade,
              ...(motion.rect
                ? {
                    "--expanded-panel-left": `${motion.rect.left}px`,
                    "--expanded-panel-top": `${motion.rect.top}px`,
                    "--expanded-panel-width": `${motion.rect.width}px`,
                    "--expanded-panel-height": `${motion.rect.height}px`,
                  }
                : {}),
            } as CSSProperties
          }
          {...(floating
            ? {
                role: "dialog",
                "aria-modal": true,
                "aria-label": `${expansion?.label} expanded`,
              }
            : {})}
          className={cn(
            "min-h-0 overflow-hidden rounded-panel border border-border/70 bg-card",
            className,
          )}
        >
          {children}
        </div>
      </MotionContext.Provider>
    </ExpansionContext.Provider>
  );
}

/** Shared header action, using the same placement in every live panel. */
export function WorkspacePanelExpandControl() {
  const expansion = useContext(ExpansionContext);
  if (!expansion) return null;
  const label = `${expansion.expanded ? "Restore" : "Expand"} ${expansion.label}`;
  return (
    <Hint content={expansion.expanded ? `${label} (Esc)` : label}>
      <Button
        data-panel-expand-control=""
        variant="ghost"
        size="icon"
        className="ml-1 size-7 shrink-0 text-muted-foreground"
        aria-label={label}
        aria-pressed={expansion.expanded}
        disabled={expansion.disabled}
        onClick={() => expansion.onExpandedChange(!expansion.expanded)}
      >
        {expansion.expanded ? (
          <Minimize2Icon className="size-3.5" />
        ) : (
          <Maximize2Icon className="size-3.5" />
        )}
      </Button>
    </Hint>
  );
}

type WorkspacePanelHeaderProps =
  | ({ as?: "div" } & ComponentPropsWithRef<"div">)
  | ({ as: "header" } & ComponentPropsWithRef<"header">);

/** One toolbar height and surface; each pane supplies its own content. */
export function WorkspacePanelHeader(props: WorkspacePanelHeaderProps) {
  const baseClassName =
    "flex h-12 shrink-0 items-center border-border border-b bg-background px-2";
  if (props.as === "header") {
    const { as: _as, className, children, ...headerProps } = props;
    return (
      <header className={cn(baseClassName, className)} {...headerProps}>
        {children}
        <WorkspacePanelExpandControl />
      </header>
    );
  }
  const { as: _as, className, children, ...divProps } = props;
  return (
    <div className={cn(baseClassName, className)} {...divProps}>
      {children}
      <WorkspacePanelExpandControl />
    </div>
  );
}

/** The plain workspace gutter, without live editor navigation controls. */
export function WorkspacePanelResizeHandle({
  collapsed = false,
  className,
  disabled,
  tabIndex,
  ...props
}: ComponentProps<typeof PanelResizeHandle> & { collapsed?: boolean }) {
  return (
    <PanelResizeHandle
      {...props}
      disabled={collapsed || disabled}
      tabIndex={collapsed ? -1 : tabIndex}
      className={cn(
        collapsed
          ? "pointer-events-none mx-0 w-0 bg-transparent"
          : "mx-0.5 w-1 bg-transparent",
        className,
      )}
    />
  );
}
