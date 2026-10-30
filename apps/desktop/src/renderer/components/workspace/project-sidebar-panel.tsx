import { Hint } from "@/components/ui/tooltip";
import { useRef, useState, type ReactNode } from "react";
import { useProjectStore } from "@/stores/project-store";
import { cn } from "@/lib/utils";

// The welcome sidebar is w-60 (240px). Keep manual resizing independent of
// this default so widening one project never changes another project's layout.
export const DEFAULT_PROJECT_SIDEBAR_WIDTH = 240;
export const MAX_PROJECT_SIDEBAR_WIDTH = 420;

export function ProjectSidebarPanel({
  projectRoot,
  collapsed,
  transitioning,
  onToggle,
  children,
}: {
  projectRoot: string | null;
  collapsed: boolean;
  transitioning: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const savedWidth = useProjectStore((state) =>
    projectRoot ? state.sidebarWidthsByProject[projectRoot] : undefined,
  );
  const saveWidth = useProjectStore((state) => state.setProjectSidebarWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);
  const width = dragWidth ?? savedWidth ?? DEFAULT_PROJECT_SIDEBAR_WIDTH;
  const clamp = (value: number) =>
    Math.min(
      MAX_PROJECT_SIDEBAR_WIDTH,
      Math.max(DEFAULT_PROJECT_SIDEBAR_WIDTH, value),
    );
  const persist = (value: number | null) => {
    if (projectRoot) saveWidth(projectRoot, value);
  };

  return (
    <>
      <div
        id="project-sidebar"
        data-project-sidebar
        className={cn(
          "h-full shrink-0 overflow-hidden",
          transitioning && "transition-[width] duration-[320ms] ease-out",
        )}
        style={{ width: collapsed ? 0 : width }}
        inert={collapsed}
      >
        {children}
      </div>
      <Hint content="Double-click to reset sidebar width">
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-controls="project-sidebar"
          aria-valuemin={DEFAULT_PROJECT_SIDEBAR_WIDTH}
          aria-valuemax={MAX_PROJECT_SIDEBAR_WIDTH}
          aria-valuenow={Math.round(width)}
          tabIndex={collapsed ? -1 : 0}
          className={cn(
            "relative shrink-0 touch-none select-none bg-transparent transition-[width,margin] duration-[320ms] ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            collapsed
              ? "pointer-events-none mx-0 w-0"
              : "mx-1 w-1 cursor-col-resize",
          )}
          onDoubleClick={() => persist(null)}
          onPointerDown={(event) => {
            if (event.button !== 0 || collapsed) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { startX: event.clientX, startWidth: width, width };
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            const next = clamp(
              drag.current.startWidth + event.clientX - drag.current.startX,
            );
            drag.current.width = next;
            setDragWidth(next);
          }}
          onPointerUp={(event) => {
            if (!drag.current) return;
            persist(drag.current.width);
            drag.current = null;
            setDragWidth(null);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragWidth(null);
          }}
          onKeyDown={(event) => {
            let next: number;
            switch (event.key) {
              case "ArrowLeft":
                next = clamp(width - 10);
                break;
              case "ArrowRight":
                next = clamp(width + 10);
                break;
              case "Home":
                next = DEFAULT_PROJECT_SIDEBAR_WIDTH;
                break;
              case "End":
                next = MAX_PROJECT_SIDEBAR_WIDTH;
                break;
              case "Enter":
                event.preventDefault();
                onToggle();
                return;
              default:
                return;
            }
            event.preventDefault();
            persist(next);
          }}
        >
          <span className="absolute -inset-x-1 inset-y-0" />
        </div>
      </Hint>
    </>
  );
}
