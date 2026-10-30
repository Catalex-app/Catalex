import { describe, expect, it } from "vitest";
import {
  getMentionFileMatches,
  isSelectionRangeContextLabel,
  parseSelectionContextLabel,
  resolveSelectionContextTarget,
} from "@/components/agent-chat/chat-composer";
import { commandSyntaxForProvider } from "@/components/agent-chat/slash-command-picker";
import { type ProjectFile, useDocumentStore } from "@/stores/document-store";
import { captureProposedDraft } from "@/lib/chat-context";

function makeFile(
  relativePath: string,
  type: ProjectFile["type"] = "other",
): ProjectFile {
  const name = relativePath.split("/").pop() ?? relativePath;
  return {
    id: relativePath,
    name,
    relativePath,
    absolutePath: `/project/${relativePath}`,
    type,
    isDirty: false,
  };
}

describe("commandSyntaxForProvider", () => {
  it("uses Pi's explicit skill marker", () => {
    expect(
      commandSyntaxForProvider(
        { full_command: "/catalex-verify-latex", scope: "skill" },
        "pi",
      ),
    ).toBe("/skill:catalex-verify-latex");
  });
  it("uses Codex's explicit skill marker for Codex skills", () => {
    expect(
      commandSyntaxForProvider(
        { full_command: "/catalex-verify-latex", scope: "skill" },
        "codex",
      ),
    ).toBe("$catalex-verify-latex");
  });

  it("keeps slash syntax for Claude skills and regular commands", () => {
    expect(
      commandSyntaxForProvider(
        { full_command: "/catalex-verify-latex", scope: "skill" },
        "claude",
      ),
    ).toBe("/catalex-verify-latex");
    expect(
      commandSyntaxForProvider(
        { full_command: "/review", scope: "default" },
        "codex",
      ),
    ).toBe("/review");
  });
});

describe("getMentionFileMatches", () => {
  it("returns all visible files for bare @ even when one folder has many early files", () => {
    const files = [
      ...Array.from({ length: 10 }, (_, index) =>
        makeFile(`Images/figure-${index}.png`, "image"),
      ),
      makeFile("Main/main.tex", "tex"),
      makeFile("Main/sections/intro.tex", "tex"),
    ];

    const matches = getMentionFileMatches(files, "");

    expect(matches.map((file) => file.relativePath)).toEqual([
      "Main/main.tex",
      "Main/sections/intro.tex",
      "Images/figure-0.png",
      "Images/figure-1.png",
      "Images/figure-2.png",
      "Images/figure-3.png",
      "Images/figure-4.png",
      "Images/figure-5.png",
      "Images/figure-6.png",
      "Images/figure-7.png",
      "Images/figure-8.png",
      "Images/figure-9.png",
    ]);
  });

  it("preserves existing hidden-directory filtering", () => {
    const matches = getMentionFileMatches(
      [
        makeFile("Main/main.tex", "tex"),
        makeFile(".catalex/latex-build/main.tex", "tex"),
      ],
      "",
    );

    expect(matches.map((file) => file.relativePath)).toEqual(["Main/main.tex"]);
  });

  it("keeps typed query matching scoped to matching paths", () => {
    const matches = getMentionFileMatches(
      [
        makeFile("Images/main-diagram.png", "image"),
        makeFile("Main/main.tex", "tex"),
        makeFile("notes.md"),
      ],
      "Main",
    );

    expect(matches.map((file) => file.relativePath)).toEqual([
      "Main/main.tex",
      "Images/main-diagram.png",
    ]);
  });
});

describe("isSelectionRangeContextLabel", () => {
  it("matches selection-range labels regardless of folder", () => {
    expect(isSelectionRangeContextLabel("PDF · p. 2")).toBe(true);
    expect(isSelectionRangeContextLabel("@main.tex:1:2-3:4")).toBe(true);
    expect(
      isSelectionRangeContextLabel("@attachments/checklist.tex:15:216-17:158"),
    ).toBe(true);
  });

  it("preserves whole-file labels, including attachments", () => {
    expect(isSelectionRangeContextLabel("@main.tex")).toBe(false);
    expect(isSelectionRangeContextLabel("@attachments/checklist.tex")).toBe(
      false,
    );
  });
});

describe("selection context targets", () => {
  it("parses selection context labels with nested file paths", () => {
    expect(parseSelectionContextLabel("@sections/intro.tex:12:3-14:8")).toEqual(
      {
        filePath: "sections/intro.tex",
        startLine: 12,
        startCol: 3,
        endLine: 14,
        endCol: 8,
      },
    );
  });

  it("resolves a selection context label to document offsets", () => {
    const files = [
      makeFile("main.tex", "tex"),
      {
        ...makeFile("sections/intro.tex", "tex"),
        content: "First line\nSelected words\nFinal line",
      },
    ];

    const target = resolveSelectionContextTarget(
      {
        label: "@sections/intro.tex:2:1-2:15",
        filePath: "sections/intro.tex",
      },
      files,
    );

    expect(target).toEqual({
      fileId: "sections/intro.tex",
      filePath: "sections/intro.tex",
      start: 11,
      end: 25,
    });
  });

  it("returns null for labels that do not point inside the file", () => {
    expect(
      resolveSelectionContextTarget(
        {
          label: "@main.tex:4:1-4:5",
          filePath: "main.tex",
        },
        [{ ...makeFile("main.tex", "tex"), content: "one\ntwo" }],
      ),
    ).toBeNull();
  });
});

it("recognizes PDF fallback badges and parses mapped PDF source ranges", () => {
  expect(isSelectionRangeContextLabel("PDF p.2 · “and like this…”")).toBe(true);
  expect(isSelectionRangeContextLabel("PDF p.2 · @main.tex:42:1-45:12")).toBe(
    true,
  );
  expect(parseSelectionContextLabel("PDF p.2 · @main.tex:42:1-45:12")).toEqual({
    filePath: "main.tex",
    startLine: 42,
    startCol: 1,
    endLine: 45,
    endCol: 12,
  });
});

it("does not navigate a proposed selection after its sandbox content changes", () => {
  const previousSession = useDocumentStore.getState().agentWorkspaceSessionId;
  useDocumentStore.setState({ agentWorkspaceSessionId: "selection-draft" });
  try {
    const context = {
      label: "@main.tex:1:1-1:6",
      filePath: "main.tex",
      selectedText: "First",
      proposedDraft: captureProposedDraft("selection-draft", "First paragraph"),
    };
    const file = { ...makeFile("main.tex", "tex"), content: "First paragraph" };
    expect(resolveSelectionContextTarget(context, [file])).not.toBeNull();
    expect(
      resolveSelectionContextTarget(context, [
        { ...file, content: "Other paragraph" },
      ]),
    ).toBeNull();
    useDocumentStore.setState({ agentWorkspaceSessionId: "another-draft" });
    expect(resolveSelectionContextTarget(context, [file])).toBeNull();
    expect(context.selectedText).toBe("First");
  } finally {
    useDocumentStore.setState({ agentWorkspaceSessionId: previousSession });
  }
});
