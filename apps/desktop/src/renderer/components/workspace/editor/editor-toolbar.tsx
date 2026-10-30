import { Hint } from "@/components/ui/tooltip";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  memo,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { FileSpreadsheetIcon, FileTextIcon, ImageIcon } from "lucide-react";
import { useDocumentStore } from "@/stores/document-store";

import { createFileListSelector } from "@/lib/file-selectors";

const NO_DRAG_STYLE: CSSProperties = {
  ["WebkitAppRegion" as keyof CSSProperties]: "no-drag",
};

export const EditorToolbar = memo(function EditorToolbar() {
  const files = useDocumentStore(useMemo(createFileListSelector, []));
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const openFileIds = useDocumentStore((s) => s.openFileIds);
  const closeOpenFile = useDocumentStore((s) => s.closeOpenFile);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);

  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const updateTabEdgeFade = useCallback(() => {
    const container = tabsScrollRef.current;
    if (!container) return;
    const maxScrollLeft = Math.max(
      0,
      container.scrollWidth - container.clientWidth,
    );
    setShowLeftFade(container.scrollLeft > 1);
    setShowRightFade(maxScrollLeft - container.scrollLeft > 1);
  }, []);
  const handleTabsWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const container = tabsScrollRef.current;
    if (!container) return;
    const hasOverflow = container.scrollWidth > container.clientWidth;
    if (!hasOverflow) return;
    if (event.deltaY === 0) return;
    event.preventDefault();
    container.scrollLeft += event.deltaY;
  }, []);

  useEffect(() => {
    updateTabEdgeFade();
  }, [openFileIds, activeFileId, updateTabEdgeFade]);

  useEffect(() => {
    const container = tabsScrollRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateTabEdgeFade();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateTabEdgeFade]);
  const handleTabMiddleClickClose = useCallback(
    (
      event: ReactMouseEvent<HTMLDivElement | HTMLButtonElement>,
      fileId: string,
    ) => {
      if (event.button !== 1) return;
      // Prevent browser middle-click/autoscroll behavior in the tab strip.
      event.preventDefault();
      event.stopPropagation();
      closeOpenFile(fileId);
    },
    [closeOpenFile],
  );

  const openFiles = openFileIds
    .map((id) => files.find((f) => f.id === id))
    .filter((f) => f != null);
  const fallbackActiveFile = files.find((f) => f.id === activeFileId);
  const tabs =
    openFiles.length > 0
      ? openFiles
      : fallbackActiveFile
        ? [fallbackActiveFile]
        : [];

  return (
    <div
      data-editor-toolbar
      className="flex h-full min-w-0 items-center gap-2 pr-2"
    >
      <div className="relative min-w-0 max-w-[90%] shrink-0">
        <div
          ref={tabsScrollRef}
          onScroll={updateTabEdgeFade}
          className="scrollbar-none min-w-0 overflow-x-auto"
          style={NO_DRAG_STYLE}
          onWheel={handleTabsWheel}
        >
          <div
            data-editor-file-tab-list
            className="flex min-w-max items-center gap-1 pr-2"
          >
            {tabs.map((file) => {
              const isActive = file.id === activeFileId;
              const showClose = tabs.length > 1;
              const TabTypeIcon =
                file.type === "image"
                  ? ImageIcon
                  : file.type === "csv"
                    ? FileSpreadsheetIcon
                    : FileTextIcon;
              return (
                <div
                  key={file.id}
                  data-editor-file-tab
                  data-middle-click-tab
                  data-active={isActive}
                  className={`editor-file-tab group flex h-8 max-w-[220px] items-center gap-1 rounded-md border px-2 transition-colors ${
                    isActive
                      ? "border-border bg-muted/50 text-foreground"
                      : "border-transparent bg-transparent text-muted-foreground hover:border-border/60 hover:bg-transparent hover:text-foreground"
                  }`}
                  onAuxClick={(event) =>
                    handleTabMiddleClickClose(event, file.id)
                  }
                >
                  <Hint content={file.relativePath}>
                    <button
                      type="button"
                      className="editor-file-tab-activate flex h-full min-w-0 flex-1 items-center gap-1 truncate text-sm"
                      onClick={() => setActiveFile(file.id)}
                      aria-label={file.relativePath}
                    >
                      <TabTypeIcon className="editor-file-tab-icon size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {file.name}
                        {file.isDirty ? " *" : ""}
                      </span>
                    </button>
                  </Hint>
                  {showClose && (
                    <Hint content={`Close ${file.name}`}>
                      <button
                        type="button"
                        className={`editor-file-tab-close flex size-5 shrink-0 items-center justify-center rounded text-xs leading-none ${
                          isActive
                            ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                            : "text-muted-foreground/80 hover:bg-muted hover:text-foreground"
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeOpenFile(file.id);
                        }}
                        aria-label={`Close ${file.name}`}
                      >
                        ×
                      </button>
                    </Hint>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {showLeftFade ? (
          <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background via-background/75 to-transparent" />
        ) : null}
        {showRightFade ? (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background via-background/75 to-transparent" />
        ) : null}
      </div>
      <div data-window-drag-region className="min-w-0 flex-1 self-stretch" />
    </div>
  );
});
