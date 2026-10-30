import { describe, expect, it } from "vitest";
import { captureProposedDraft, isEarlierDraftContext } from "./chat-context";
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
