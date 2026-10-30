import { useEffect, useRef } from "react";
import {
  startCommentRangeDrag,
  styleCommentRangeHandle,
  type CommentRangeEdge,
} from "../editor/comment-range";

export function CommentRangeHandle({
  edge,
  hidden = false,
  agent,
  x,
  y,
  height,
  onMove,
  onFinish,
}: {
  hidden?: boolean;
  edge: CommentRangeEdge;
  agent: boolean;
  x: number;
  y: number;
  height: number;
  onMove: (x: number, y: number) => void;
  onFinish: (commit: boolean) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onMove, onFinish });
  callbacks.current = { onMove, onFinish };
  useEffect(() => {
    const handle = ref.current!;
    styleCommentRangeHandle(handle, edge, agent);
    let cancel: (() => void) | undefined;
    handle.onpointerdown = (event) => {
      if (event.button !== 0) return;
      cancel = startCommentRangeDrag(
        event,
        handle,
        (x, y) => callbacks.current.onMove(x, y),
        (commit) => callbacks.current.onFinish(commit),
      );
    };
    return () => {
      cancel?.();
      handle.replaceChildren();
    };
  }, [edge, agent]);
  return (
    <button
      ref={ref}
      type="button"
      style={{
        opacity: hidden ? 0 : 1,
        left: `${x}%`,
        top: `${y}%`,
        height: `${height}%`,
      }}
    />
  );
}
