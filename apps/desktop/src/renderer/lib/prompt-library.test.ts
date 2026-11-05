import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_LIBRARY,
  normalizePromptLibrary,
  resolveLibraryPromptContext,
  resolvePromptIcon,
  type PromptDiagnosticSnapshot,
} from "./prompt-library";

const selection = {
  label: "@main.tex:1:1-1:6",
  filePath: "main.tex",
  selectedText: "Hello",
};
const file = { relativePath: "main.tex", content: "Hello world", type: "tex" };

describe("prompt library", () => {
  it("preserves icon choices and opt-out while accepting older prompts", () => {
    const { icon: _icon, ...older } = DEFAULT_PROMPT_LIBRARY[0];
    const custom = { ...older, id: "custom" };
    expect(normalizePromptLibrary([older, custom])).toEqual([older, custom]);
    expect(resolvePromptIcon(older)).toBe("spell-check");
    expect(resolvePromptIcon(custom)).toBe("bookmark");
    expect(resolvePromptIcon({ ...custom, id: "improve-clarity" })).toBe(
      "pencil",
    );
    expect(resolvePromptIcon({ ...custom, id: "review-structure" })).toBe(
      "list-tree",
    );
    expect(resolvePromptIcon({ ...older, icon: null })).toBeNull();
    expect(
      normalizePromptLibrary([{ ...custom, icon: "target" }])[0].icon,
    ).toBe("target");
    expect(
      normalizePromptLibrary([{ ...older, icon: null }])[0].icon,
    ).toBeNull();
    expect(
      normalizePromptLibrary([{ ...custom, icon: "invalid icon key" }])[0],
    ).toEqual(custom);
  });
  it("preserves an empty library and rejects malformed or duplicate saved entries", () => {
    expect(normalizePromptLibrary(undefined)).toEqual(DEFAULT_PROMPT_LIBRARY);
    expect(normalizePromptLibrary([])).toEqual([]);
    const prompt = { ...DEFAULT_PROMPT_LIBRARY[0], enabled: false };
    expect(
      normalizePromptLibrary([
        null,
        {},
        prompt,
        prompt,
        { ...prompt, id: "bad", title: " " },
      ]),
    ).toEqual([prompt]);
  });
  it("automatically prefers a selection, then a text file, and allows context-free prompts", () => {
    expect(
      resolveLibraryPromptContext(
        { ...DEFAULT_PROMPT_LIBRARY[2], availability: "selection" },
        [],
        file,
        null,
      ).unavailable,
    ).toBe("Select text first");
    expect(
      resolveLibraryPromptContext(
        DEFAULT_PROMPT_LIBRARY[0],
        [selection],
        file,
        null,
      ).context,
    ).toEqual({ ...selection, selectionPinned: true });
    expect(
      resolveLibraryPromptContext(
        DEFAULT_PROMPT_LIBRARY[3],
        [selection],
        file,
        null,
      ).context?.selectedText,
    ).toBe("Hello");
    expect(
      resolveLibraryPromptContext(DEFAULT_PROMPT_LIBRARY[3], [], file, "draft")
        .context,
    ).toMatchObject({
      selectedText: "Hello world",
      selectionKey: "file:main.tex",
      proposedDraft: { sessionId: "draft" },
    });
    expect(
      resolveLibraryPromptContext(
        DEFAULT_PROMPT_LIBRARY[0],
        [],
        undefined,
        null,
      ),
    ).toEqual({});
    expect(
      resolveLibraryPromptContext(
        DEFAULT_PROMPT_LIBRARY[0],
        [],
        { ...file, isBinary: true },
        null,
      ),
    ).toEqual({});
    expect(
      resolveLibraryPromptContext(
        DEFAULT_PROMPT_LIBRARY[0],
        [],
        { ...file, type: "pdf" },
        null,
      ),
    ).toEqual({});
  });

  it("keeps custom legacy prompts and translates their availability without restoring deleted defaults", () => {
    const legacy = {
      id: "custom",
      title: "Custom",
      prompt: "My instruction",
      context: "selection",
      enabled: false,
      icon: null,
    };
    expect(normalizePromptLibrary([legacy])).toEqual([
      {
        id: "custom",
        title: "Custom",
        prompt: "My instruction",
        availability: "selection",
        enabled: false,
        icon: null,
      },
    ]);
    for (const context of ["auto", "document", "none"])
      expect(
        normalizePromptLibrary([{ ...legacy, context }])[0].availability,
      ).toBe("always");
    expect(
      normalizePromptLibrary([{ ...legacy, availability: "issues" }])[0]
        .availability,
    ).toBe("issues");
  });

  it("replaces the untouched writing defaults together and preserves user edits", () => {
    const clarity = {
      id: "improve-clarity",
      title: "Improve clarity",
      prompt:
        "Improve the clarity and flow of the attached text. Keep its meaning, technical details, citations, and markup intact.",
      context: "auto",
      enabled: true,
      icon: "pencil",
    };
    const structure = {
      id: "review-structure",
      title: "Review structure",
      prompt:
        "Review the structure and logical flow of the attached document. Identify gaps, repetition, and unclear transitions, and suggest concrete improvements. Do not edit the document yet.",
      context: "document",
      enabled: true,
      icon: "list-tree",
    };
    const custom = {
      id: "custom",
      title: "Custom",
      prompt: "My text",
      context: "none",
      enabled: false,
    };
    const proofread = {
      ...DEFAULT_PROMPT_LIBRARY[0],
      id: "proofread",
      title: "Proofread",
      icon: "spell-check",
      prompt:
        "Proofread the attached text and fix spelling, grammar, and punctuation. Preserve its meaning, style, and markup.",
    };
    const explain = {
      ...DEFAULT_PROMPT_LIBRARY[0],
      id: "explain-selection",
      title: "Explain selection",
      icon: "lightbulb",
      availability: "selection",
      prompt:
        "Explain the selected text in plain language, including any notation or assumptions. Do not edit the document.",
    };
    const previous = [
      proofread,
      DEFAULT_PROMPT_LIBRARY[1],
      explain,
      {
        ...DEFAULT_PROMPT_LIBRARY[0],
        icon: "list-tree",
        prompt:
          "Improve the clarity, flow, and structure of the attached text. Address repetition, unclear transitions, and logical gaps while preserving its meaning, technical details, citations, and markup.",
      },
    ];
    for (const stock of [previous, [proofread, clarity, explain, structure]]) {
      const result = normalizePromptLibrary([...stock, custom]);
      expect(result.slice(0, 4)).toEqual(DEFAULT_PROMPT_LIBRARY);
      expect(result[4]).toMatchObject({
        id: "custom",
        prompt: "My text",
        enabled: false,
      });
      expect(normalizePromptLibrary(result)).toEqual(result);
    }
    expect(normalizePromptLibrary(previous.slice(1))).toEqual(
      previous.slice(1),
    );
    const edited = [
      { ...proofread, prompt: "My own proofreading prompt" },
      ...previous.slice(1),
    ];
    expect(normalizePromptLibrary(edited)).toEqual(edited);
    for (const change of [
      { prompt: "My own clarity prompt" },
      { enabled: false },
      { icon: null },
    ]) {
      const result = normalizePromptLibrary([
        { ...clarity, ...change },
        structure,
      ]);
      expect(result.map((p) => p.id)).toEqual([
        "improve-clarity",
        "review-structure",
      ]);
      expect(result[0]).toMatchObject(change);
    }
    expect(normalizePromptLibrary([clarity]).map((p) => p.id)).toEqual([
      "improve-clarity",
    ]);
  });
});

const issueFile = {
  relativePath: "main.tex",
  content: "Clean line\nBroken command\nAnother issue\n",
  type: "tex",
};
const snapshot: PromptDiagnosticSnapshot = {
  projectRoot: "/project",
  draftSessionId: null,
  filePath: "main.tex",
  content: issueFile.content,
  issues: [
    {
      from: 11,
      to: 25,
      line: 2,
      endLine: 2,
      severity: "error",
      message: "Undefined control sequence",
    },
    {
      from: 26,
      to: 39,
      line: 3,
      endLine: 3,
      severity: "warning",
      message: "Missing reference",
    },
    {
      from: null,
      to: null,
      line: null,
      endLine: null,
      severity: "error",
      message: "Compiler failed",
    },
  ],
};
const selectedIssue = {
  label: "@main.tex:2:1-3:1",
  filePath: "main.tex",
  selectedText: "Broken command\n",
};
const fix = DEFAULT_PROMPT_LIBRARY[1];
const resolveIssues = (
  contexts: (typeof selection)[] = [],
  diagnostics = snapshot,
  currentFile = issueFile,
  session: string | null = null,
) =>
  resolveLibraryPromptContext(
    fix,
    contexts,
    currentFile,
    session,
    diagnostics,
    "/project",
  );

describe("issue prompt availability", () => {
  it("attaches only issues overlapping the selection, respecting its exclusive end", () => {
    const result = resolveIssues([selectedIssue]);
    expect(result.unavailable).toBeUndefined();
    expect(result.context).toMatchObject({
      selectedText: selectedIssue.selectedText,
      diagnostics: [
        { line: 2, severity: "error", message: "Undefined control sequence" },
      ],
    });
  });
  it("includes file-wide and unlocated issues only without a selection", () => {
    expect(resolveIssues().context?.diagnostics).toHaveLength(3);
    const clean = {
      label: "@main.tex:1:1-2:1",
      filePath: "main.tex",
      selectedText: "Clean line\n",
    };
    expect(resolveIssues([clean])).toEqual({
      unavailable: "No issues in this selection",
    });
    expect(resolveIssues([], { ...snapshot, issues: [] })).toEqual({
      unavailable: "No issues in this file",
    });
  });
  it("includes a diagnostic starting before the selection when it spans the selected line", () => {
    expect(
      resolveIssues([selectedIssue], {
        ...snapshot,
        issues: [{ ...snapshot.issues[0], line: 1, endLine: 2 }],
      }).context?.diagnostics,
    ).toHaveLength(1);
  });
  it.each([
    { projectRoot: "/other" },
    { filePath: "other.tex" },
    { draftSessionId: "old-draft" },
    { content: "Old content" },
  ])("rejects diagnostics from a different snapshot: %j", (change) => {
    expect(
      resolveIssues([selectedIssue], { ...snapshot, ...change }).unavailable,
    ).toBeTruthy();
  });
  it("does not attach current-file issues to a stale, unanchored, or other-file selection", () => {
    for (const change of [
      { selectedText: "Old text" },
      { filePath: "other.tex" },
      { label: "PDF · p. 1" },
      { label: "@main.tex:20:1-21:1" },
    ])
      expect(
        resolveIssues([{ ...selectedIssue, ...change }]).unavailable,
      ).toBeTruthy();
    const oldDraft = {
      ...selectedIssue,
      proposedDraft: { sessionId: "old-draft" },
    };
    expect(resolveIssues([oldDraft]).unavailable).toBeTruthy();
  });
  it("prefers the live selection over an earlier pinned selection and ignores non-text attachments", () => {
    const pinned = { ...selectedIssue, selectionPinned: true };
    const clean = {
      label: "@main.tex:1:1-2:1",
      filePath: "main.tex",
      selectedText: "Clean line\n",
    };
    expect(resolveIssues([pinned, clean]).unavailable).toBeTruthy();
    const comment = {
      ...clean,
      comment: { id: "c", text: "Comment", agent: false },
    };
    expect(resolveIssues([comment]).context?.diagnostics).toHaveLength(3);
  });
});
