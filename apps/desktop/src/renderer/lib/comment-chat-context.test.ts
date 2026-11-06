import { useDocumentStore } from "@/stores/document-store";
import { describe, expect, it } from "vitest";
import { formatChatPrompt } from "./chat-prompt";
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
  it("keeps PDF comment text, document path and selected passage together", () => {
    const context = commentChatContext("papers/a/paper.pdf", {
      ...comment,
      from: 0,
      to: 0,
      pdf: {
        fingerprint: "a".repeat(40),
        text: "The measured result is 42.",
        regions: [{ page: 3, x: 20, y: 30, width: 90, height: 12 }],
      },
    });
    const prompt = formatChatPrompt("Review this.", undefined, [context]);
    expect(prompt).toContain("File: papers/a/paper.pdf");
    expect(prompt).toContain("Location: PDF page 3");
    expect(prompt).toContain("Selected PDF text:\nThe measured result is 42.");
    expect(prompt).toContain(`Comment:\n${comment.text}`);
    expect(prompt).not.toContain("offsets");
  });
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
