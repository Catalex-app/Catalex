import { useDocumentStore } from "@/stores/document-store";
import { describe, expect, it } from "vitest";
import {
  commentChatContext,
  commentsInSelection,
} from "./comment-chat-context";

const comment = {
  id: "stable-id",
  number: 4,
  from: 10,
  to: 20,
  line: 2,
  text: "Clarify the baseline",
};

describe("comment chat context", () => {
  it("includes a stable file/id reference and comment snapshot", () => {
    const context = commentChatContext("intro.tex", comment);
    expect(context.label).toBe("H-4 · intro.tex");
    expect(context.comment).toMatchObject({
      id: "stable-id",
      agent: false,
      text: comment.text,
    });
    expect(context.comment).toMatchObject({
      label: "H-4",
      line: 2,
      from: 10,
      to: 20,
      resolved: false,
    });
    expect(context.selectedText).toBe(comment.text);
    expect(
      commentChatContext("intro.tex", {
        ...comment,
        origin: { provider: "codex", sessionId: "a" },
      }).comment?.agent,
    ).toBe(true);
  });

  it("uses the same deselection lifecycle as text and PDF selections", () => {
    const store = useDocumentStore.getState();
    const context = commentChatContext("intro.tex", comment);
    store.setSelectionRange({ start: 0, end: 5 });
    store.setCommentSelectionContext(context);
    expect(useDocumentStore.getState().selectionRange).toBeNull();
    expect(useDocumentStore.getState().commentSelectionContext).toEqual(
      context,
    );
    store.setSelectionRange(null);
    expect(useDocumentStore.getState().commentSelectionContext).toBeNull();
    store.setCommentSelectionContext(context);
    store.setPdfSelectionContext({
      label: "PDF · p. 1",
      filePath: "intro.tex",
      selectedText: "text",
    });
    expect(useDocumentStore.getState().commentSelectionContext).toBeNull();
    store.setSelectionRange(null);
  });
});

it("attaches overlapping comments, excluding resolved and adjacent passages", () => {
  const contexts = commentsInSelection(
    "intro.tex",
    [
      comment,
      { ...comment, id: "overlapping", from: 18, to: 30 },
      { ...comment, id: "resolved", resolved: true },
      { ...comment, id: "adjacent", from: 20, to: 30 },
    ],
    10,
    20,
  );
  expect(contexts.map((context) => context.comment?.id)).toEqual([
    "stable-id",
    "overlapping",
  ]);
});
