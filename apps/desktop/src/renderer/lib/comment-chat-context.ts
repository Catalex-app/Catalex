import type { InlineEditorComment } from "@/components/workspace/editor/inline-comments";
import { useDocumentStore } from "@/stores/document-store";
import { SELECTION_OWNER_EVENT } from "./workspace-events";
import type { ChatContextBadge } from "./chat-context";

export function commentChatContext(
  filePath: string,
  comment: InlineEditorComment,
): ChatContextBadge {
  const label = `${comment.origin ? "A" : "H"}-${comment.number ?? comment.expectedNumber ?? 1}`;
  return {
    label: `${label} · ${filePath}`,
    filePath,
    selectionKey: `comment:${JSON.stringify([filePath, comment.id])}`,
    comment: {
      id: comment.id,
      agent: Boolean(comment.origin),
      text: comment.text,
      label,
      resolved: Boolean(comment.resolved),
      line: comment.line,
      from: comment.from,
      to: comment.to,
    },
    selectedText: comment.text,
  };
}

export function attachCommentToChat(
  projectRoot: string | null,
  filePath: string,
  comment: InlineEditorComment,
) {
  const document = useDocumentStore.getState();
  if (
    !projectRoot ||
    document.projectRoot !== projectRoot ||
    document.agentWorkspaceRoot ||
    !comment.text.trim()
  )
    return;
  document.setSelectionRange(null);
  window.dispatchEvent(
    new CustomEvent(SELECTION_OWNER_EVENT, { detail: "none" }),
  );
  document.setCommentSelectionContext(commentChatContext(filePath, comment));
}

export function commentsInSelection(
  filePath: string,
  comments: InlineEditorComment[],
  start: number,
  end: number,
): ChatContextBadge[] {
  return comments
    .filter(
      (comment) =>
        !comment.resolved &&
        comment.text.trim() &&
        comment.from < end &&
        comment.to > start,
    )
    .map((comment) => commentChatContext(filePath, comment));
}
