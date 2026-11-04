import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithRef,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Maximize2Icon,
  Minimize2Icon,
  AppWindowIcon,
  EllipsisIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/ui/tooltip";
import { ProblemsMotion } from "./editor/problems-motion";
import { PanelResizeHandle } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { canHandleEscape } from "@/lib/keyboard-events";
import {
  usePanelExpansionMotion,
  type PanelExpansionMotion,
} from "./use-panel-expansion-motion";
import "./workspace-panel.css";

export interface WorkspacePanelExpansion {
  label: string;
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  disabled?: boolean;
  onPopOut?: () => void;
}
const ExpansionContext = createContext<WorkspacePanelExpansion | undefined>(
  undefined,
);

const MotionContext = createContext<PanelExpansionMotion | undefined>(
  undefined,
);

function canKeepFocus(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element !== document.body &&
    element.isConnected &&
    !element.closest('[inert], [disabled], [aria-hidden="true"]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
}

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
  const lastContentFocusRef = useRef<HTMLElement | null>(null);
  const backgroundRef = useRef<HTMLElement[]>([]);
  const onExpandedChangeRef = useRef(expansion?.onExpandedChange);
  onExpandedChangeRef.current = expansion?.onExpandedChange;
  const expanded = expansion?.expanded ?? false;
  const motion = usePanelExpansionMotion(panelRef, expanded);
  const floating = motion.floating;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!floating || !panel) return;
    let lastFocus = document.activeElement;
    let navigatingWithKeyboard = false;
    const focusContent = () => {
      const remembered = lastContentFocusRef.current;
      const target =
        remembered && panel.contains(remembered) && canKeepFocus(remembered)
          ? remembered
          : (panel.querySelector<HTMLElement>(
              '.cm-content[contenteditable="true"], [data-chat-composer-shell] [contenteditable="true"], [data-chat-composer-shell] textarea',
            ) ??
            panel.querySelector<HTMLElement>("[data-panel-content-focus]") ??
            panel.querySelector<HTMLElement>("[data-preview-pane][tabindex]") ??
            panel);
      target.focus({ preventScroll: true });
    };
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
    const active = document.activeElement;
    if (
      !canKeepFocus(active) ||
      !panel.contains(active) ||
      active.closest(
        ".workspace-panel-control-motion, [data-panel-floating-controls]",
      )
    )
      focusContent();
    const focusin = () => {
      lastFocus = document.activeElement;
    };
    const pointerdown = () => {
      navigatingWithKeyboard = false;
    };
    panel.addEventListener("focusin", focusin);
    panel.addEventListener("pointerdown", pointerdown, true);
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
        navigatingWithKeyboard = true;
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
        } else if (!focusable.includes(document.activeElement as HTMLElement)) {
          // Preview scroll areas are programmatically focusable, outside the
          // normal Tab sequence. Keep the next Tab inside the expanded panel.
          const candidates = event.shiftKey
            ? [...focusable].reverse()
            : focusable;
          const next = candidates.find(
            (element) =>
              target.compareDocumentPosition(element) &
              (event.shiftKey
                ? Node.DOCUMENT_POSITION_PRECEDING
                : Node.DOCUMENT_POSITION_FOLLOWING),
          );
          event.preventDefault();
          (next ?? (event.shiftKey ? last : first))?.focus();
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
      panel.removeEventListener("focusin", focusin);
      panel.removeEventListener("pointerdown", pointerdown, true);
      for (const ancestor of ancestors)
        ancestor.removeAttribute("data-expanded-panel-ancestor");
      for (const [sibling, inert] of siblings) sibling.inert = inert;
      // The content stays mounted through resizing: preserve its current focus.
      if (canKeepFocus(document.activeElement)) return;
      if (
        navigatingWithKeyboard &&
        lastFocus?.closest("[data-panel-floating-controls]")
      )
        panel
          .querySelector<HTMLButtonElement>(
            ".workspace-panel-control-motion [data-panel-expand-control]",
          )
          ?.focus({ preventScroll: true });
      else if (panel.isConnected) focusContent();
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
          tabIndex={props.tabIndex ?? -1}
          onFocusCapture={(event) => {
            props.onFocusCapture?.(event);
            const target = event.target;
            if (
              target instanceof HTMLElement &&
              !target.closest(
                "[data-workspace-panel-header], [data-panel-floating-controls]",
              )
            )
              lastContentFocusRef.current = target;
          }}
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
            "min-h-0 overflow-hidden rounded-panel border border-border/70 bg-card outline-none",
            className,
          )}
        >
          {expansion?.onExpandedChange && (
            <div
              data-panel-floating-controls=""
              data-expanded-panel-actions={floating ? "" : undefined}
              className="pointer-events-none fixed inset-x-3 top-0 z-50 flex h-9 items-center justify-end"
              style={{ visibility: floating ? "visible" : "hidden" }}
              aria-hidden={!floating}
              inert={!floating || !expanded}
            >
              <div
                data-window-drag-region
                className="pointer-events-auto ml-[var(--traffic-light-width,0px)] flex-1 self-stretch"
              />
              <WorkspacePanelExpandControl floatingBar />
            </div>
          )}
          {children}
        </div>
      </MotionContext.Provider>
    </ExpansionContext.Provider>
  );
}

/** Shared header action, using the same placement in every live panel. */
export function WorkspacePanelExpandControl({
  actionsLabel = "Panel",
  floatingBar = false,
  hasTrailingContent = false,
  overflowContent,
  onActionsOpenChange,
  onActionsEscapeKeyDown,
}: {
  actionsLabel?: string;
  floatingBar?: boolean;
  hasTrailingContent?: boolean;
  overflowContent?: ReactNode;
  onActionsOpenChange?: (open: boolean) => void;
  onActionsEscapeKeyDown?: (event: KeyboardEvent) => void;
} = {}) {
  const expansion = useContext(ExpansionContext);
  const motion = useContext(MotionContext);
  const expandAfterMenuClose = useRef(false);
  if (!expansion && !overflowContent) return null;
  const label = expansion?.label ?? actionsLabel;
  const hasWindowActions = !!(
    expansion?.onExpandedChange || expansion?.onPopOut
  );
  const hasActions = hasWindowActions || !!overflowContent;
  const primary = expansion?.onExpandedChange && (
    <Hint
      content={`Restore ${expansion.label} (Esc)`}
      onFocus={(event) => event.preventDefault()}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        aria-label={`Restore ${expansion.label}`}
        aria-pressed
        disabled={expansion.disabled}
        onClick={() => expansion.onExpandedChange?.(false)}
      >
        <Minimize2Icon className="size-3" />
      </Button>
    </Hint>
  );
  const popOut = expansion?.onPopOut && (
    <Hint content="Pop out">
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        aria-label={`Pop out ${expansion.label}`}
        disabled={expansion.disabled}
        onClick={expansion.onPopOut}
      >
        <AppWindowIcon className="size-3.5" />
      </Button>
    </Hint>
  );
  if (floatingBar)
    return (
      <ProblemsMotion
        kind="button"
        open={!!expansion?.expanded && !!motion?.floating}
      >
        <div className="pointer-events-auto flex items-center gap-1">
          {popOut}
          {primary}
        </div>
      </ProblemsMotion>
    );
  return (
    <ProblemsMotion
      kind="button"
      open
      className="workspace-panel-control-motion"
    >
      <div className="flex items-center">
        <ProblemsMotion kind="button" open={hasTrailingContent}>
          <div
            data-panel-control-separator=""
            aria-hidden="true"
            className="mx-2 h-4 w-px shrink-0 bg-border"
          />
        </ProblemsMotion>
        <ButtonGroup
          variant="plain"
          aria-label={`${label} view actions`}
          className="inline-flex h-6 shrink-0 items-center"
        >
          <DropdownMenu onOpenChange={onActionsOpenChange}>
            <Hint
              content={hasActions ? "Panel actions" : "No actions available"}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  data-panel-expand-control=""
                  variant="ghost"
                  size="icon-xs"
                  className="size-6 text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                  aria-label={`More ${label} view actions`}
                  disabled={expansion?.disabled || !hasActions}
                >
                  <EllipsisIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent
              align="end"
              onEscapeKeyDown={onActionsEscapeKeyDown}
              onCloseAutoFocus={(event) => {
                if (!expandAfterMenuClose.current) return;
                event.preventDefault();
                expandAfterMenuClose.current = false;
                // Let the menu release focus before the expanded panel receives it.
                expansion?.onExpandedChange?.(!expansion.expanded);
              }}
            >
              {expansion && (
                <>
                  {expansion.onExpandedChange && (
                    <DropdownMenuItem
                      aria-label={`${expansion.expanded ? "Restore" : "Expand"} ${label}`}
                      onSelect={() => {
                        expandAfterMenuClose.current = true;
                      }}
                    >
                      {expansion.expanded ? (
                        <Minimize2Icon className="size-3" />
                      ) : (
                        <Maximize2Icon className="size-3" />
                      )}
                      {expansion.expanded ? "Restore panel" : "Expand panel"}
                      <DropdownMenuShortcut>
                        <Kbd className="font-sans">Double-click</Kbd>
                      </DropdownMenuShortcut>
                    </DropdownMenuItem>
                  )}
                  {expansion.onPopOut && (
                    <DropdownMenuItem
                      aria-label={`Pop out ${label}`}
                      onSelect={expansion.onPopOut}
                    >
                      <AppWindowIcon className="size-3.5" />
                      Pop out
                      <DropdownMenuShortcut>
                        <Kbd aria-label={isMacPlatform() ? "Option" : "Alt"}>
                          {isMacPlatform() ? "⌥" : "Alt"}
                        </Kbd>
                        <Kbd className="font-sans">Double-click</Kbd>
                      </DropdownMenuShortcut>
                    </DropdownMenuItem>
                  )}
                  {hasWindowActions && overflowContent && (
                    <DropdownMenuSeparator />
                  )}
                </>
              )}
              {overflowContent}
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      </div>
    </ProblemsMotion>
  );
}

type WorkspacePanelHeaderProps = {
  actionsLabel?: string;
  trailingContent?: ReactNode;
  overflowContent?: ReactNode;
  onActionsOpenChange?: (open: boolean) => void;
  onActionsEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Visible content on the right, before the window controls. */
  hasTrailingContent?: boolean;
} & (
  | ({ as?: "div" } & ComponentPropsWithRef<"div">)
  | ({ as: "header" } & ComponentPropsWithRef<"header">)
);

/** One toolbar height and surface; each pane supplies its own content. */
// Native header drag regions cannot receive double-clicks. Keep panel gestures
// on blank space only; controls, text and portalled menus retain their behavior.
function isBlankPanelHeader(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !event.currentTarget.contains(target))
    return false;
  const control = target.closest(
    'button, input, textarea, select, a, label, [role], [contenteditable="true"], [data-panel-header-trailing]',
  );
  // The header itself may be a toolbar; only controls inside it block gestures.
  if (
    control &&
    control !== event.currentTarget &&
    event.currentTarget.contains(control)
  )
    return false;
  if (target !== event.currentTarget && target.tagName !== "DIV") return false;
  return !Array.from(target.childNodes).some(
    (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
  );
}

export function WorkspacePanelHeader(props: WorkspacePanelHeaderProps) {
  const expansion = useContext(ExpansionContext);
  const {
    as: Tag = "div",
    actionsLabel,
    className,
    children,
    hasTrailingContent,
    trailingContent,
    overflowContent,
    onActionsOpenChange,
    onActionsEscapeKeyDown,
    onDoubleClick,
    onMouseDown,
    ...rest
  } = props;
  const shared = {
    "data-workspace-panel-header": "",
    className: cn(
      "flex h-12 shrink-0 items-center border-border border-b bg-background px-2",
      className,
    ),
    onMouseDown: (event: MouseEvent<HTMLDivElement>) => {
      onMouseDown?.(event);
      if (
        !event.defaultPrevented &&
        event.detail === 2 &&
        (expansion?.onExpandedChange || expansion?.onPopOut) &&
        !expansion.disabled &&
        isBlankPanelHeader(event)
      )
        event.preventDefault();
    },
    onDoubleClick: (event: MouseEvent<HTMLDivElement>) => {
      onDoubleClick?.(event);
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        !expansion ||
        expansion.disabled ||
        !isBlankPanelHeader(event)
      )
        return;
      if (event.altKey) expansion.onPopOut?.();
      else expansion.onExpandedChange?.(!expansion.expanded);
    },
  };
  const content = (
    <>
      {children}
      <div data-panel-header-space="" className="w-14 shrink-0 self-stretch" />
      <div
        data-panel-header-trailing=""
        className="ml-auto flex shrink-0 items-center"
      >
        {trailingContent}
        <WorkspacePanelExpandControl
          actionsLabel={actionsLabel}
          hasTrailingContent={hasTrailingContent ?? !!trailingContent}
          overflowContent={overflowContent}
          onActionsOpenChange={onActionsOpenChange}
          onActionsEscapeKeyDown={onActionsEscapeKeyDown}
        />
      </div>
    </>
  );
  return Tag === "header" ? (
    <header {...(rest as ComponentPropsWithRef<"header">)} {...shared}>
      {content}
    </header>
  ) : (
    <div {...(rest as ComponentPropsWithRef<"div">)} {...shared}>
      {content}
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
