import { useEffect, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function QueuedPromptRow({
  id,
  index,
  disabled,
  onStep,
  children,
}: {
  id: string;
  index: number;
  disabled: boolean;
  onStep: (direction: -1 | 1) => void;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    node,
  } = useSortable({ id, disabled });

  // A translated row contributes to scroll overflow. Keep it within the real
  // first/last row positions so edge scrolling cannot create an empty tail.
  let boundedTransform = transform;
  const row = node.current;
  const first = row?.parentElement?.firstElementChild as HTMLElement | null;
  const last = row?.parentElement?.lastElementChild as HTMLElement | null;
  if (isDragging && transform && row && first && last) {
    boundedTransform = {
      ...transform,
      y: Math.max(
        first.offsetTop - row.offsetTop,
        Math.min(transform.y, last.offsetTop - row.offsetTop),
      ),
    };
  }

  useEffect(() => {
    if (!isDragging) return;
    // Use the sensor's cancellation path, including its listener cleanup.
    const cancel = () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
        }),
      );
    const cancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancel();
    };
    const cancelWhenHidden = () => {
      if (document.hidden) cancel();
    };
    if (disabled) cancel();
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancelWhenHidden);
    document.addEventListener("contextmenu", cancelContextMenu, true);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancelWhenHidden);
      document.removeEventListener("contextmenu", cancelContextMenu, true);
    };
  }, [disabled, isDragging]);

  return (
    <li
      ref={setNodeRef}
      data-queued-prompt-id={id}
      data-queue-dragging={isDragging || undefined}
      style={{
        transform: CSS.Translate.toString(boundedTransform),
        transition,
      }}
      className={cn(
        "group/queued-prompt relative flex items-start gap-1 rounded-md px-0.5 py-0.5 hover:bg-muted/60",
        isDragging &&
          "z-10 bg-background shadow-sm ring-1 ring-ring ring-inset hover:bg-background [&_[data-queued-prompt-actions]]:hidden",
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Move queued prompt ${index + 1}`}
        disabled={disabled}
        className="size-6 shrink-0 cursor-grab touch-none p-1 text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
        onKeyDown={(event) => {
          if (isDragging) return;
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          event.stopPropagation();
          onStep(event.key === "ArrowUp" ? -1 : 1);
        }}
      >
        <GripVerticalIcon className="size-3.5" aria-hidden="true" />
      </Button>
      {children}
    </li>
  );
}
