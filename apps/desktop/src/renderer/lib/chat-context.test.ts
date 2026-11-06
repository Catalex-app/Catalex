import { describe, expect, it } from "vitest";
import {
  captureProposedDraft,
  isEarlierDraftContext,
  isSameSelectionContext,
  pdfSelectionKey,
  isSelectionRangeContextLabel,
} from "./chat-context";
import { formatChatPrompt } from "./chat-prompt";

describe("proposed draft context", () => {
  const context = {
    label: "@main.tex:1:1-1:6",
    filePath: "main.tex",
    selectedText: "Draft",
    proposedDraft: captureProposedDraft("draft-a", "Draft text"),
  };

  it("recognizes edits outside a captured selection and other sandbox sessions", () => {
    expect(isEarlierDraftContext(context, "draft-a", "Draft text")).toBe(false);
    expect(isEarlierDraftContext(context, "draft-a", "Draft revision")).toBe(
      true,
    );
    expect(isEarlierDraftContext(context, "draft-b", "Draft text")).toBe(true);
    expect(isEarlierDraftContext(context, null, "Draft text")).toBe(true);
  });

  it("preserves the selected quote and identifies its source in the agent prompt", () => {
    const prompt = formatChatPrompt("Revise this", "main.tex", [context]);
    expect(prompt).toContain("Source: Agent proposed draft");
    expect(prompt).toContain("Draft session: draft-a");
    expect(prompt).toContain("Text:\nDraft");
    expect(prompt).toContain("[User request]\nRevise this");
  });

  it("leaves source-project attachments unmarked", () => {
    expect(captureProposedDraft(null, "text")).toBeUndefined();
    expect(
      isEarlierDraftContext({ ...context, proposedDraft: undefined }, null),
    ).toBe(false);
  });
});

describe("PDF selection identity", () => {
  const excerpt = {
    label: "PDF p.1 · @papers/a/main.tex · “Introduction”",
    filePath: "papers/a/main.tex",
    selectedText: "Introduction",
    selectionKey: "pdf:document-a-position-1",
    pdf: {
      documentPath: "papers/a/main.tex",
      kind: "compiled" as const,
      page: 1,
    },
  };
  it("recognizes document-qualified and older PDF labels as selections", () => {
    expect(isSelectionRangeContextLabel(excerpt.label)).toBe(true);
    expect(isSelectionRangeContextLabel("PDF p.1 · “Introduction”")).toBe(true);
  });
  it("never merges different PDF positions or unidentified older captures by text", () => {
    expect(isSameSelectionContext(excerpt, { ...excerpt })).toBe(true);
    expect(
      isSameSelectionContext(excerpt, {
        ...excerpt,
        selectionKey: "pdf:document-a-position-2",
      }),
    ).toBe(false);
    expect(
      isSameSelectionContext(excerpt, { ...excerpt, pdf: undefined }),
    ).toBe(false);
    expect(
      isSameSelectionContext(excerpt, {
        ...excerpt,
        pdf: { ...excerpt.pdf, documentPath: "papers/b/main.tex" },
      }),
    ).toBe(false);
  });
});

it("normalizes PDF coordinate noise across zoom levels without merging distinct locations", () => {
  const pdf = {
    documentPath: "papers/a/main.tex",
    kind: "compiled" as const,
    page: 1,
  };
  const first = pdfSelectionKey(
    pdf,
    117.62899017333984,
    285.00396728515625,
    "Introduction",
  );
  expect(
    pdfSelectionKey(pdf, 117.62899017333984, 285.0039978027344, "Introduction"),
  ).toBe(first);
  expect(pdfSelectionKey(pdf, 117.63, 300, "Introduction")).not.toBe(first);
  expect(
    pdfSelectionKey(
      { ...pdf, documentPath: "papers/b/main.tex" },
      117.63,
      285.004,
      "Introduction",
    ),
  ).not.toBe(first);
});
