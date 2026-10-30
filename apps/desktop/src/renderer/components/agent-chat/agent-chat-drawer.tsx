import { CHAT_DRAWER_MAX_WIDTH as DRAWER_MAX_WIDTH } from "@/lib/chat-layout";
import {
  type ReactNode,
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
} from "react";

import { cn } from "@/lib/utils";
import { isNewChatTab, useAgentChatStore } from "@/stores/agent-chat-store";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import {
  AgentDraftNotice,
  useActiveAgentQuestion,
} from "./agent-question-prompt";
import { ChatMessages } from "./chat-messages";
import { ChatComposer } from "./chat-composer";
import { ChatTabBar } from "./chat-tab-bar";
import { SessionSelector } from "./session-selector";

const MIN_OPEN_HEIGHT = 150;
const DEFAULT_HEIGHT = 360;
const OPEN_HEIGHT_RATIO = 0.5;
const COLLAPSE_OPEN_TRANSITION_MS = 160;
const OPEN_DRAG_THRESHOLD = 22;
const COLLAPSE_SNAP_DISTANCE = 16;
const MESSAGE_FADE_DISTANCE = 64;
const MORPH_TRANSITION_MS = 220;
const DRAWER_INTRO_REVEAL_MS = 240;
const DISPLAY_CONTROL_EXTRA_HEIGHT = 24;
const HANDLE_HOVER_SHOW_MS = 50;
const HANDLE_HOVER_HIDE_MS = 150;
const DRAWER_CORNER_RADIUS = 16;

export function AgentChatDrawer({
  open,
  onOpenChange,
  preferredHeight,
  onHeightChange,
  displayControl,
  isExiting = false,
  transitionMorphActive = false,
  morphToPanel = false,
  composerTransferPhase = "idle",
  introRevealActive = false,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  preferredHeight?: number;
  onHeightChange?: (height: number) => void;
  displayControl?: ReactNode;
  isExiting?: boolean;
  transitionMorphActive?: boolean;
  morphToPanel?: boolean;
  composerTransferPhase?:
    | "idle"
    | "drawer_exit"
    | "drawer_enter_prep"
    | "drawer_enter";
  introRevealActive?: boolean;
}) {
  const { resume } = useActiveAgentQuestion();
  const heightRatio = resume ? 0.85 : OPEN_HEIGHT_RATIO;
  const drawerCollapseRequestNonce = useAgentChatStore(
    (s) => s.drawerCollapseRequestNonce,
  );
  const drawerOpenRequested = useAgentChatStore((s) => s.drawerOpenRequested);
  const activeTabId = useAgentChatStore((s) => s.activeTabId);
  const hasNewChat = useAgentChatStore((s) => s.tabs.some(isNewChatTab));
  const requestNewChat = useAgentChatStore((s) => s.requestNewChat);

  const [localIsOpen, setLocalIsOpen] = useState(false);
  const isOpen = open ?? localIsOpen;
  const setIsOpen = onOpenChange ?? setLocalIsOpen;
  const [localPreferredHeight, setLocalPreferredHeight] =
    useState(DEFAULT_HEIGHT);
  const chosenHeight = preferredHeight ?? localPreferredHeight;
  const [height, setHeight] = useState(chosenHeight);
  const [panelTransitionMs, setPanelTransitionMs] = useState(300);
  const [isDragging, setIsDragging] = useState(false);
  const [isCollapsePreview, setIsCollapsePreview] = useState(false);
  const [isHandleHovered, setIsHandleHovered] = useState(false);
  const [isHandleFocused, setIsHandleFocused] = useState(false);
  const handleHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const clearHandleHoverTimer = useCallback(() => {
    if (handleHoverTimerRef.current !== null) {
      clearTimeout(handleHoverTimerRef.current);
      handleHoverTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearHandleHoverTimer, [clearHandleHoverTimer]);
  const showDisplayControl =
    Boolean(displayControl) &&
    !transitionMorphActive &&
    (isOpen || isHandleHovered || isHandleFocused || isDragging);
  const displayControlExtraHeight = showDisplayControl
    ? DISPLAY_CONTROL_EXTRA_HEIGHT
    : 0;
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const composerSlotRef = useRef<HTMLDivElement>(null);
  const handledCollapseRequestRef = useRef(drawerCollapseRequestNonce);
  const hasDraggedRef = useRef(false);
  const dragActiveRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const heightRef = useRef(height);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const pendingAttachments = useAgentChatStore((s) => s.pendingAttachments);
  const getOpenMaxHeight = useCallback(() => {
    const parent = containerRef.current?.parentElement;
    return parent ? parent.clientHeight * heightRatio : 400;
  }, [heightRatio]);

  const clampOpenHeight = useCallback(
    (value: number) => {
      if (!Number.isFinite(value) || value <= 0) return MIN_OPEN_HEIGHT;
      return Math.min(
        Math.max(Math.ceil(value), MIN_OPEN_HEIGHT),
        getOpenMaxHeight(),
      );
    },
    [getOpenMaxHeight],
  );

  const getCollapsedContentHeight = useCallback(() => {
    const chromeHeight = chromeRef.current?.getBoundingClientRect().height ?? 0;
    const composerHeight =
      composerSlotRef.current?.getBoundingClientRect().height ?? 0;
    const measured = Math.ceil(chromeHeight + composerHeight);
    if (!Number.isFinite(measured) || measured <= 0) return 0;
    return Math.min(measured, getOpenMaxHeight());
  }, [getOpenMaxHeight]);

  const ensureMinPanelHeight = useCallback(() => {
    if (!isOpen || dragActiveRef.current) return;
    const collapsedRequired = getCollapsedContentHeight();

    const nextHeight = clampOpenHeight(
      Math.max(chosenHeight, collapsedRequired - displayControlExtraHeight),
    );
    if (nextHeight !== heightRef.current) {
      heightRef.current = nextHeight;
      setHeight(nextHeight);
    }
  }, [
    clampOpenHeight,
    getCollapsedContentHeight,
    isOpen,
    displayControlExtraHeight,
    chosenHeight,
  ]);

  // Auto-open only when a new attachment is added.
  useEffect(() => {
    const shouldOpen = pendingAttachments.some(
      (context) => !context.selectionKey?.startsWith("file:"),
    );
    if (shouldOpen && !isOpen) {
      setIsOpen(true);
    }
  }, [isOpen, pendingAttachments]);

  // Preserve the chosen height across composer/tab changes. Grow only when
  // header and composer content cannot fit, never by accumulating resize deltas.
  // Collapsed sizing is handled by CSS so constrained content cannot shrink-loop.
  useLayoutEffect(() => {
    ensureMinPanelHeight();
  }, [ensureMinPanelHeight, isDragging]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      ensureMinPanelHeight();
    });
    const parent = containerRef.current?.parentElement;
    if (parent) observer.observe(parent);
    if (chromeRef.current) observer.observe(chromeRef.current);
    if (composerSlotRef.current) observer.observe(composerSlotRef.current);
    return () => observer.disconnect();
  }, [ensureMinPanelHeight]);

  const setTransitionFor = useCallback(() => {
    setPanelTransitionMs(COLLAPSE_OPEN_TRANSITION_MS);
  }, []);

  useEffect(() => {
    if (drawerCollapseRequestNonce === handledCollapseRequestRef.current)
      return;
    handledCollapseRequestRef.current = drawerCollapseRequestNonce;
    if (!isOpen) return;
    setTransitionFor();
    setIsOpen(false);
  }, [drawerCollapseRequestNonce, isOpen, setTransitionFor]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (transitionMorphActive) return;
      e.preventDefault();
      dragCleanupRef.current?.();
      dragActiveRef.current = true;
      hasDraggedRef.current = false;
      setIsCollapsePreview(false);

      const wasOpenAtDragStart = isOpen;
      const startY = e.clientY;
      // Hover chrome may still be animating; it must not reduce the saved base.
      const startHeight = wasOpenAtDragStart
        ? heightRef.current
        : (panelRef.current?.offsetHeight ?? heightRef.current) -
          displayControlExtraHeight;
      const dragExtraHeight = displayControl ? DISPLAY_CONTROL_EXTRA_HEIGHT : 0;
      let openedFromCollapsedDrag = false;
      let collapseOnRelease = false;

      const handleMouseMove = (event: MouseEvent) => {
        // A release outside the window may never deliver mouseup here.
        if ((event.buttons & 1) === 0) {
          handleMouseUp();
          return;
        }
        const delta = startY - event.clientY;
        if (!wasOpenAtDragStart && !openedFromCollapsedDrag) {
          if (delta <= OPEN_DRAG_THRESHOLD) return;
          openedFromCollapsedDrag = true;
          setPanelTransitionMs(COLLAPSE_OPEN_TRANSITION_MS);
          setIsOpen(true);
        }
        if (Math.abs(delta) < 3) return;
        if (!hasDraggedRef.current) setIsDragging(true);
        hasDraggedRef.current = true;

        // Keep the composer readable as the message area runs out of space.
        // scrollHeight avoids measuring a composer already squeezed by the drag.
        const chromeHeight =
          chromeRef.current?.getBoundingClientRect().height ?? 0;
        const composerHeight = composerSlotRef.current?.scrollHeight ?? 0;
        const minOpenHeight = Math.min(
          Math.max(
            chromeHeight - dragExtraHeight + composerHeight + 2,
            MIN_OPEN_HEIGHT,
          ),
          getOpenMaxHeight(),
        );
        collapseOnRelease =
          wasOpenAtDragStart &&
          delta < 0 &&
          startHeight + delta <= minOpenHeight + COLLAPSE_SNAP_DISTANCE;
        setIsCollapsePreview(collapseOnRelease);
        const newHeight = Math.min(
          Math.max(startHeight + delta, minOpenHeight),
          getOpenMaxHeight(),
        );
        heightRef.current = newHeight;
        if (panelRef.current) {
          panelRef.current.style.height = `${newHeight + dragExtraHeight}px`;
          panelRef.current.style.setProperty(
            "--drawer-message-opacity",
            String(
              Math.min(1, (newHeight - minOpenHeight) / MESSAGE_FADE_DISTANCE),
            ),
          );
        }
      };

      const handleMouseUp = () => {
        if (!dragActiveRef.current) return;
        dragActiveRef.current = false;
        setIsDragging(false);
        setIsCollapsePreview(false);

        if (collapseOnRelease) {
          setPanelTransitionMs(COLLAPSE_OPEN_TRANSITION_MS);
          setIsOpen(false);
        } else if (
          hasDraggedRef.current &&
          (wasOpenAtDragStart || openedFromCollapsedDrag)
        ) {
          const nextHeight = heightRef.current;
          setHeight(nextHeight);
          setLocalPreferredHeight(nextHeight);
          onHeightChange?.(nextHeight);
        }

        dragCleanupRef.current?.();
      };

      dragCleanupRef.current = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        window.removeEventListener("blur", handleMouseUp);
        panelRef.current?.style.removeProperty("--drawer-message-opacity");
        dragActiveRef.current = false;
        dragCleanupRef.current = null;
      };
      window.addEventListener("blur", handleMouseUp);
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [
      getOpenMaxHeight,
      displayControlExtraHeight,
      isOpen,
      transitionMorphActive,
      onHeightChange,
      displayControl,
    ],
  );

  const panelStyle = (): React.CSSProperties => {
    if (transitionMorphActive) {
      return {
        height: "100%",
        maxWidth: "100%",
        borderRadius: "inherit",
      };
    }
    if (!isOpen) {
      // Let flex layout shrink the options, not a measured height feeding back
      // into itself whenever the composer is constrained.
      return {
        maxHeight: `${heightRatio * 100}%`,
        maxWidth: DRAWER_MAX_WIDTH,
        borderRadius: DRAWER_CORNER_RADIUS,
      };
    }
    return {
      height:
        (isDragging ? heightRef.current : height) + displayControlExtraHeight,
      maxWidth: DRAWER_MAX_WIDTH,
      borderRadius: DRAWER_CORNER_RADIUS,
    };
  };

  const setDrawerOpen = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        if (isOpen) return;
        ensureMinPanelHeight();
        setTransitionFor();
        setIsOpen(true);
        return;
      }
      if (!isOpen) return;
      setTransitionFor();
      setIsOpen(false);
    },
    [ensureMinPanelHeight, isOpen, setTransitionFor],
  );

  const handleHeaderBarClick = useCallback(() => {
    if (transitionMorphActive) return;
    if (hasDraggedRef.current) {
      hasDraggedRef.current = false;
      return;
    }
    setDrawerOpen(!isOpen);
  }, [isOpen, setDrawerOpen, transitionMorphActive]);

  useEffect(() => {
    if (!drawerOpenRequested) return;
    setDrawerOpen(true);
    useAgentChatStore.getState().consumeDrawerOpenRequest();
  }, [drawerOpenRequested, setDrawerOpen]);

  const showFullChatContent = isOpen || transitionMorphActive;
  const sessionsInHeader = isOpen && !transitionMorphActive;
  const isComposerTransferActive = composerTransferPhase !== "idle";
  const chromeTransition = transitionMorphActive
    ? morphToPanel
      ? "opacity 80ms cubic-bezier(0.2, 0.9, 0.25, 1), transform 120ms cubic-bezier(0.2, 0.9, 0.25, 1), max-height 120ms cubic-bezier(0.2, 0.9, 0.25, 1)"
      : "opacity 110ms cubic-bezier(0.2, 0.9, 0.25, 1) 40ms, transform 150ms cubic-bezier(0.2, 0.9, 0.25, 1) 20ms, max-height 140ms cubic-bezier(0.2, 0.9, 0.25, 1) 20ms"
    : undefined;

  useEffect(() => {
    if (!transitionMorphActive) return;
    clearHandleHoverTimer();
    setIsHandleHovered(false);
  }, [transitionMorphActive, clearHandleHoverTimer]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "pointer-events-none absolute inset-0 z-10 flex items-end justify-center transition-[padding] duration-300 ease-out",
        transitionMorphActive ? "items-stretch justify-stretch p-0" : "p-4",
      )}
      style={{
        transitionDuration: `${transitionMorphActive || isComposerTransferActive ? MORPH_TRANSITION_MS : panelTransitionMs}ms`,
      }}
    >
      {/* Chat panel */}
      <div
        ref={panelRef}
        data-chat-drawer-panel="true"
        className={cn(
          "flex w-full flex-col overflow-hidden border bg-background transition-[height,max-width,border-radius,border-color,box-shadow,opacity,transform] duration-300 ease-out",
          transitionMorphActive ? "pointer-events-none" : "pointer-events-auto",
          transitionMorphActive
            ? "border-border/70 bg-card shadow-none"
            : "border-border shadow-2xl",
          "scale-100 opacity-100",
          isDragging && "!transition-none",
        )}
        style={{
          ...panelStyle(),
          // Keep collapsed sizing intrinsic while animating to/from an open height.
          interpolateSize: "allow-keywords",
          transitionDuration: `${transitionMorphActive || isComposerTransferActive ? 0 : panelTransitionMs}ms`,
          transformOrigin: "50% 50%",
          animation: isExiting
            ? "workspace-drawer-tv-off 220ms both cubic-bezier(0.55, 0.06, 0.68, 0.19)"
            : introRevealActive
              ? `drawer-opacity-reveal ${DRAWER_INTRO_REVEAL_MS}ms both cubic-bezier(0.2, 0.9, 0.25, 1)`
              : undefined,
        }}
      >
        {/* Header with drag handle, tab bar, and session selector */}
        <div
          ref={chromeRef}
          className="@container/chat-drawer shrink-0 transition-[opacity,transform,max-height] duration-200 ease-out"
          style={{
            opacity: transitionMorphActive ? (morphToPanel ? 0 : 1) : 1,
            transform:
              transitionMorphActive && morphToPanel
                ? "translate3d(0, -8px, 0)"
                : "translate3d(0, 0, 0)",
            maxHeight: transitionMorphActive && morphToPanel ? 0 : 160,
            transition: chromeTransition,
            pointerEvents: transitionMorphActive ? "none" : undefined,
          }}
        >
          <div
            className={cn(
              "relative",
              sessionsInHeader &&
                "grid grid-cols-[minmax(2.75rem,1fr)_auto_minmax(2.75rem,1fr)]",
            )}
          >
            <div
              className={cn(
                "relative mx-auto flex w-64 max-w-full items-center justify-center transition-[height] ease-out",
                sessionsInHeader &&
                  "col-start-2 w-auto @max-[280px]/chat-drawer:[&_[data-chat-display]_svg]:hidden",
              )}
              style={{
                height: 16 + displayControlExtraHeight,
                transitionDuration: `${panelTransitionMs}ms`,
              }}
              onMouseEnter={() => {
                clearHandleHoverTimer();
                handleHoverTimerRef.current = setTimeout(() => {
                  handleHoverTimerRef.current = null;
                  setPanelTransitionMs(COLLAPSE_OPEN_TRANSITION_MS);
                  setIsHandleHovered(true);
                }, HANDLE_HOVER_SHOW_MS);
              }}
              onMouseLeave={() => {
                clearHandleHoverTimer();
                handleHoverTimerRef.current = setTimeout(() => {
                  handleHoverTimerRef.current = null;
                  setIsHandleHovered(false);
                }, HANDLE_HOVER_HIDE_MS);
              }}
              onFocus={(event) => {
                if (event.target.matches(":focus-visible"))
                  setIsHandleFocused(true);
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setIsHandleFocused(false);
              }}
              onMouseDownCapture={(event) => {
                if (
                  (event.target as HTMLElement).closest(
                    '[data-chat-display="Expanded"]',
                  )
                ) {
                  handleMouseDown(event);
                }
              }}
              onClickCapture={(event) => {
                if (hasDraggedRef.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  hasDraggedRef.current = false;
                }
              }}
            >
              <button
                type="button"
                aria-label="Toggle drawer"
                onMouseDown={handleMouseDown}
                onClick={handleHeaderBarClick}
                disabled={transitionMorphActive}
                tabIndex={showDisplayControl ? -1 : 0}
                className={cn(
                  "absolute inset-0 flex items-center justify-center",
                  showDisplayControl && "pointer-events-none",
                )}
              >
                <span
                  className="h-[3px] w-10 rounded-full bg-muted-foreground/30 transition-opacity duration-150 motion-reduce:transition-none"
                  style={{
                    opacity: showDisplayControl ? 0 : 1,
                  }}
                />
              </button>
              <div
                inert={!showDisplayControl}
                data-drag-snap-target={
                  isDragging && isCollapsePreview ? "mini" : undefined
                }
                className={cn(
                  "relative transition-opacity duration-150 motion-reduce:transition-none",
                  showDisplayControl
                    ? "opacity-100"
                    : "pointer-events-none opacity-0",
                  "[&_[data-chat-display=Expanded]]:cursor-row-resize",
                  isDragging &&
                    isCollapsePreview &&
                    "[&_[data-chat-display=Collapsed]]:bg-primary/5 [&_[data-chat-display=Collapsed]]:text-primary [&_[data-chat-display=Collapsed]]:ring-1 [&_[data-chat-display=Collapsed]]:ring-primary/40 [&_[data-chat-display=Collapsed]]:ring-inset dark:[&_[data-chat-display=Collapsed]]:bg-primary/10",
                )}
              >
                {displayControl}
              </div>
            </div>
            {sessionsInHeader && (
              <>
                <div className="absolute inset-y-0 left-2 flex items-center">
                  <SessionSelector />
                </div>
                <div className="absolute inset-y-0 right-2 flex items-center">
                  <Hint content="New chat">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 text-muted-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground dark:disabled:hover:bg-transparent"
                      aria-label="New tab"
                      disabled={hasNewChat}
                      onClick={() => requestNewChat()}
                    >
                      <PlusIcon className="size-3.5" />
                    </Button>
                  </Hint>
                </div>
              </>
            )}
          </div>
          <ChatTabBar
            compact={transitionMorphActive ? false : !isOpen}
            showSessionSelector={!sessionsInHeader}
            showNewChatButton={!sessionsInHeader}
            insetDivider
          />
        </div>

        {/* Messages area (hidden in collapsed mode) */}
        {showFullChatContent && (
          <div
            key={activeTabId}
            data-chat-messages
            className="relative min-h-0 flex-1 overflow-hidden"
            style={{ opacity: "var(--drawer-message-opacity, 1)" }}
          >
            <ChatMessages
              revealHistory={composerTransferPhase !== "drawer_enter_prep"}
            />
          </div>
        )}

        {showFullChatContent && <AgentDraftNotice />}

        {/* Composer */}
        <div
          ref={composerSlotRef}
          data-chat-composer-shell="true"
          data-composer-transfer-phase={composerTransferPhase}
          className="mt-auto flex min-h-0 flex-col"
          style={{
            opacity: composerTransferPhase === "drawer_enter_prep" ? 0 : 1,
            transform:
              composerTransferPhase === "drawer_exit"
                ? "translate3d(0, calc(105% + 56px), 0) scaleX(0.9) scaleY(1.14)"
                : composerTransferPhase === "drawer_enter_prep"
                  ? "translate3d(0, calc(105% + 56px), 0)"
                  : "translate3d(0, 0, 0)",
            transformOrigin: "50% 100%",
            transition:
              composerTransferPhase === "drawer_exit"
                ? "none"
                : composerTransferPhase === "drawer_enter"
                  ? "transform 210ms cubic-bezier(0.18, 1.15, 0.24, 1), opacity 170ms cubic-bezier(0.18, 0.9, 0.24, 1)"
                  : "none",
            animation:
              composerTransferPhase === "drawer_exit"
                ? "composer-rush-exit-drawer 190ms both linear"
                : "none",
            pointerEvents:
              composerTransferPhase === "drawer_exit" ||
              composerTransferPhase === "drawer_enter_prep"
                ? "none"
                : undefined,
          }}
        >
          <ChatComposer isOpen={showFullChatContent} />
        </div>
      </div>
    </div>
  );
}
