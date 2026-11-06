import { describe, expect, it } from "vitest";
import { chatContextItems, type ChatContextBadge } from "./chat-context";
import { formatChatPrompt } from "./chat-prompt";

const text: ChatContextBadge = {
  label: "@intro.tex:12:1-15:4",
  filePath: "intro.tex",
  selectedText: "The baseline uses the standard configuration.",
};
const comment: ChatContextBadge = {
  label: "H-4 · intro.tex",
  filePath: "intro.tex",
  selectedText: "Please clarify the baseline.",
  comment: {
    id: "stable-id",
    label: "H-4",
    agent: false,
    text: "Please clarify the baseline.",
    resolved: false,
    line: 12,
    from: 240,
    to: 290,
  },
};

describe("chat prompt context", () => {
  it("keeps diagnostic snapshots with their source text and separate from the user request", () => {
    const context = {
      ...text,
      diagnostics: [
        { line: 12, severity: "error", message: "Undefined control sequence" },
        { line: null, severity: "warning", message: "Unlocated warning" },
      ],
    };
    const result = formatChatPrompt(
      "Fix issues.",
      "intro.tex",
      JSON.parse(JSON.stringify([context])),
    );
    expect(result).toContain(
      "Text:\nThe baseline uses the standard configuration.",
    );
    expect(result).toContain(
      "Detected issues:\n- intro.tex:12 — [error] Undefined control sequence\n- intro.tex — [warning] Unlocated warning",
    );
    expect(result).toContain("[User request]\nFix issues.");
  });
  it("formats mixed text and human comments separately without losing their identity", () => {
    expect(
      formatChatPrompt("Revise this passage.", "intro.tex", [text, comment]),
    ).toBe(
      "[Currently open file: intro.tex]\n\n[Selected text]\nFile: intro.tex\nRange: line 12, column 1 to line 15, column 4\nText:\nThe baseline uses the standard configuration.\n\n[Attached comment — snapshot]\nLabel: H-4\nID: stable-id\nFile: intro.tex\nCreated by: human\nStatus: open\nLocation: line 12, offsets 240–290\nComment:\nPlease clarify the baseline.\n\n[User request]\nRevise this passage.",
    );
  });
  it("includes agent provenance and ignores obsolete reply data for comment-only requests even without an open file", () => {
    const reply = {
      id: "reply-1",
      text: "The baseline needs a citation.",
      createdAt: "2026-09-21",
    };
    const prompt = formatChatPrompt("Explain this feedback.", undefined, [
      {
        ...comment,
        comment: {
          ...comment.comment!,
          agent: true,
          label: "A-4",
          resolved: true,
          ...JSON.parse(JSON.stringify({ replies: [reply] })),
        },
      },
    ]);
    expect(prompt).toContain("Created by: agent\nStatus: resolved");
    expect(prompt).not.toContain("Replies:");
    expect(prompt).not.toContain(reply.text);
    expect(prompt).not.toContain("[Selected text]");
    expect(prompt).toContain("[User request]\nExplain this feedback.");
  });
  it("retains separate files and remains intact across paused-request serialization", () => {
    const contexts = [text, { ...comment, filePath: "methods.tex" }];
    expect(
      formatChatPrompt(
        "Compare.",
        "main.tex",
        JSON.parse(JSON.stringify(contexts)),
      ),
    ).toBe(formatChatPrompt("Compare.", "main.tex", contexts));
    expect(formatChatPrompt("Compare.", "main.tex", contexts)).toContain(
      "File: methods.tex",
    );
  });
  it("supports single-context callers and legacy image attachments", () => {
    const legacy = {
      ...text,
      imageDataUrls: ["data:image/png;base64,fixture"],
    };
    expect(formatChatPrompt("Explain.", "intro.tex", legacy)).toBe(
      formatChatPrompt("Explain.", "intro.tex", [text]),
    );
    expect(chatContextItems(legacy)[0].imageDataUrls).toEqual(
      legacy.imageDataUrls,
    );
    const image = { ...text, imageDataUrl: "data:image/png;base64,fixture" };
    expect(chatContextItems([image])[0].imageDataUrl).toBe(image.imageDataUrl);
    expect(formatChatPrompt("Describe.", undefined, [image])).toContain(
      "[Attached image]",
    );
    expect(formatChatPrompt("Hello")).toBe("Hello");
  });
  it("uses stored creator metadata rather than inferring it from a badge label", () => {
    const oldDraft = {
      ...comment,
      comment: { id: "stable-id", agent: true, text: "Human-edited wording" },
    };
    const prompt = formatChatPrompt("Review.", "intro.tex", [oldDraft]);
    expect(prompt).toContain("Created by: agent");
    expect(prompt).toContain("Human-edited wording");
    expect(prompt).not.toContain("undefined");
  });
});

it("sends PDF document identity and page even when source mapping is unavailable", () => {
  const contexts: ChatContextBadge[] = [
    {
      label: "PDF p.3 · @papers/a/main.tex · “Introduction”",
      filePath: "papers/a/main.tex",
      selectedText: "Introduction",
      pdf: { documentPath: "papers/a/main.tex", kind: "compiled", page: 3 },
    },
    {
      label: "PDF p.3 · @chapters/intro.tex:12:1-15:4",
      filePath: "chapters/intro.tex",
      selectedText: "Introduction",
      pdf: { documentPath: "papers/b/main.tex", kind: "compiled", page: 3 },
    },
    {
      label: "PDF p.3 · @references/main.pdf · “Introduction”",
      filePath: "references/main.pdf",
      selectedText: "Introduction",
      pdf: { documentPath: "references/main.pdf", kind: "file", page: 3 },
    },
  ];
  const prompt = formatChatPrompt(
    "Compare these",
    undefined,
    JSON.parse(JSON.stringify(contexts)),
  );
  expect(prompt).toContain("PDF compiled from: papers/a/main.tex\nPDF page: 3");
  expect(prompt).toContain(
    "PDF compiled from: papers/b/main.tex\nPDF page: 3\nRange: line 12, column 1 to line 15, column 4",
  );
  expect(prompt).toContain("PDF document: references/main.pdf\nPDF page: 3");
  expect(prompt).not.toContain("document.pdf");
  expect(prompt.match(/\[Selected text\]/g)).toHaveLength(3);
});
