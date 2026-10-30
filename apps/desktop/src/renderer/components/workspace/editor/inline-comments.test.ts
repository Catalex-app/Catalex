import {
  ChangeSet,
  Compartment,
  EditorState,
  StateEffect,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInlineCommentExtension,
  updateInlineCommentsEffect,
  isInlineCommentRangeAllowed,
  type InlineCommentActions,
  mapInlineCommentsThroughChanges as mapComments,
  normalizeInlineCommentRange,
  type InlineEditorComment,
} from "./inline-comments";

// Run the existing boundary/deletion cases through both supported input paths.
function mapInlineCommentsThroughChanges(
  comments: InlineEditorComment[],
  changes: ChangeSet,
  nextDoc: string,
  previousDoc?: string,
) {
  const result = mapComments(
    comments,
    changes,
    EditorState.create({ doc: nextDoc }),
    previousDoc === undefined
      ? undefined
      : EditorState.create({ doc: previousDoc }),
  );
  expect(result).toEqual(mapComments(comments, changes, nextDoc, previousDoc));
  return result;
}

let view: EditorView | null = null;

it("shows stored model and thinking effort, with a legacy fallback", async () => {
  const origin = { provider: "codex" as const, sessionId: "session" };
  const comment = {
    id: "agent",
    from: 0,
    to: 4,
    line: 1,
    text: "Review",
    origin,
  };
  const compartment = new Compartment();
  const editor = createView("text", []);
  editor.dispatch({
    effects: StateEffect.appendConfig.of(
      compartment.of(createInlineCommentExtension([comment])),
    ),
  });
  await vi.waitFor(() => {
    expect(document.querySelector(".cm-inlineCommentOrigin")?.textContent).toBe(
      "Agent",
    );
  });
  editor.dispatch({
    effects: compartment.reconfigure(
      createInlineCommentExtension([
        {
          ...comment,
          origin: { ...origin, model: "gpt-5.4", thinkingEffort: "high" },
        },
      ]),
    ),
  });
  await vi.waitFor(() => {
    expect(document.querySelector(".cm-inlineCommentOrigin")?.textContent).toBe(
      "gpt-5.4 · high",
    );
  });
});

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

function createView(
  doc: string,
  comments: InlineEditorComment[],
  actions?: InlineCommentActions,
) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [createInlineCommentExtension(comments, actions)],
    }),
  });
  return view;
}

function getInjectedStyleText(): string {
  return Array.from(document.querySelectorAll("style"))
    .map((style) => style.textContent ?? "")
    .join("\n");
}

function getInlineCommentCardStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentCard \{[^}]+\}/)?.[0] ?? ""
  );
}

function getInlineCommentTimeStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentTime[^}]+\}/)?.[0] ?? ""
  );
}

function getInlineCommentHeaderStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentHeader \{[^}]+\}/)?.[0] ??
    ""
  );
}

function getInlineCommentEditingHeaderStyleRule(): string {
  return (
    getInjectedStyleText().match(
      /\.cm-inlineCommentCardEditing \.cm-inlineCommentHeader[^{}]*\{[^}]+\}/,
    )?.[0] ?? ""
  );
}

function getInlineCommentTextStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentText \{[^}]+\}/)?.[0] ?? ""
  );
}

function getInlineCommentBodyStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentBody \{[^}]+\}/)?.[0] ?? ""
  );
}

function getInlineCommentContentStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentContent \{[^}]+\}/)?.[0] ??
    ""
  );
}

function getInlineCommentTransitioningCardStyleRule(): string {
  return (
    getInjectedStyleText().match(
      /\.cm-inlineCommentCardTransitioning \{[^}]+\}/,
    )?.[0] ?? ""
  );
}

function getInlineCommentEditBodyStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentEditBody \{[^}]+\}/)?.[0] ??
    ""
  );
}

function getInlineCommentControlsStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentControls \{[^}]+\}/)?.[0] ??
    ""
  );
}

function getInlineCommentEditingControlsStyleRule(): string {
  return (
    getInjectedStyleText().match(
      /\.cm-inlineCommentCardEditing \.cm-inlineCommentControls \{[^}]+\}/,
    )?.[0] ?? ""
  );
}

function getInlineCommentDeleteConfirmControlsStyleRule(): string {
  return (
    getInjectedStyleText().match(
      /\.cm-inlineCommentControlsConfirmingDelete \{[^}]+\}/,
    )?.[0] ?? ""
  );
}

function getInlineCommentDeleteConfirmStyleRule(): string {
  return (
    getInjectedStyleText().match(
      /\.cm-inlineCommentDeleteConfirm \{[^}]+\}/,
    )?.[0] ?? ""
  );
}

function getInlineCommentTransitioningDeleteConfirmStyleRule(): string {
  return (
    getInjectedStyleText().match(
      /\.cm-inlineCommentControlsTransitioning \.cm-inlineCommentDeleteConfirm[^{]*\{[^}]+\}/,
    )?.[0] ?? ""
  );
}

function getInlineCommentButtonStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentButton \{[^}]+\}/)?.[0] ??
    ""
  );
}

function getInlineCommentFirstButtonStyleRule(): string {
  return (
    getInjectedStyleText().match(
      /\.cm-inlineCommentButton:first-child \{[^}]+\}/,
    )?.[0] ?? ""
  );
}

function getInlineCommentLastButtonStyleRule(): string {
  return (
    getInjectedStyleText().match(
      /\.cm-inlineCommentButton:last-child \{[^}]+\}/,
    )?.[0] ?? ""
  );
}

function getInlineCommentIconStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentIcon \{[^}]+\}/)?.[0] ?? ""
  );
}

function getInlineCommentEditorStyleRule(): string {
  return (
    getInjectedStyleText().match(/\.cm-inlineCommentEditor \{[^}]+\}/)?.[0] ??
    ""
  );
}

describe("inline editor comments", () => {
  it.each([
    ["delete", false],
    ["resolve", false],
    ["delete", true],
    ["resolve", true],
    ["cancel", false],
  ] as const)("wipes away before %s (agent=%s)", (action, agent) => {
    const commit = vi.fn();
    createView(
      "some text",
      [
        {
          id: "leaving",
          from: 0,
          to: 4,
          line: 1,
          text: action === "cancel" ? "" : "Review",
          isEditing: action === "cancel",
          ...(agent
            ? { origin: { provider: "codex" as const, sessionId: "session" } }
            : {}),
        },
      ],
      { onDelete: commit, onResolve: commit, onSave: vi.fn() },
    );
    const card = document.querySelector<HTMLElement>(".cm-inlineCommentCard")!;
    const animation = {
      onfinish: null as (() => void) | null,
      cancel: vi.fn(),
    };
    const animate = vi.fn(() => animation);
    Object.defineProperty(card, "animate", { value: animate });
    const mark = document.querySelector<HTMLElement>(".cm-inlineCommentMark")!;
    const marker = document.querySelector<HTMLElement>(
      ".cm-inlineCommentSuperscript",
    )!;
    const fade = { cancel: vi.fn(), startTime: null };
    const fadeMark = vi.fn(() => fade);
    const fadeMarker = vi.fn(() => ({ cancel: vi.fn(), startTime: null }));
    Object.defineProperty(mark, "animate", { value: fadeMark });
    Object.defineProperty(marker, "animate", { value: fadeMarker });
    if (action !== "cancel") {
      card
        .querySelector<HTMLButtonElement>(
          `[data-inline-comment-action="${action}"]`,
        )!
        .click();
    }
    const confirm = card.querySelector<HTMLButtonElement>(
      `[data-inline-comment-action="${action === "cancel" ? "cancel" : `confirm-${action}`}"]`,
    )!;
    confirm.click();
    confirm.click();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(mark.dataset.inlineCommentId).toBe("leaving");
    expect(fadeMark).toHaveBeenCalledWith(
      [
        expect.objectContaining({ backgroundColor: expect.any(String) }),
        { backgroundColor: "transparent", borderBottomColor: "transparent" },
      ],
      { duration: 120, easing: "linear", fill: "forwards" },
    );
    expect(fadeMarker).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], {
      duration: 120,
      easing: "linear",
      fill: "forwards",
    });
    expect(animate).toHaveBeenCalledWith(
      [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 0 100%)" }],
      { duration: 120, easing: "linear", fill: "forwards" },
    );
    expect(card.inert).toBe(true);
    expect(card.dataset.confirmAction).toBe(
      action === "cancel" ? undefined : action,
    );
    expect(commit).not.toHaveBeenCalled();
    animation.onfinish!();
    expect(commit).toHaveBeenCalledExactlyOnceWith("leaving");
    // React removes the card later; keep it wiped out until widget destruction.
    expect(animation.cancel).not.toHaveBeenCalled();
    expect(card.inert).toBe(true);
    view?.destroy();
    view = null;
    expect(animation.cancel).toHaveBeenCalledOnce();
    expect(fade.cancel).toHaveBeenCalledOnce();
  });
  it.each([
    false,
    true,
  ])("previews resolve and delete across the whole card (agent=%s)", (agent) => {
    const onResolve = vi.fn();
    const onDelete = vi.fn();
    createView(
      "some text",
      [
        {
          id: "preview",
          from: 0,
          to: 4,
          line: 1,
          text: "Review",
          ...(agent
            ? { origin: { provider: "codex" as const, sessionId: "session" } }
            : {}),
        },
      ],
      { onResolve, onDelete },
    );
    const card = document.querySelector<HTMLElement>(".cm-inlineCommentCard")!;
    for (const action of ["resolve", "delete"]) {
      card
        .querySelector<HTMLButtonElement>(
          `[data-inline-comment-action="${action}"]`,
        )!
        .click();
      expect(card.dataset.confirmAction).toBe(action);
      expect(onResolve).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
      document.body.click();
      expect(card.dataset.confirmAction).toBeUndefined();
      card
        .querySelector<HTMLButtonElement>(
          `[data-inline-comment-action="${action}"]`,
        )!
        .click();
      const cancel = card.querySelector<HTMLButtonElement>(
        '[data-inline-comment-action="cancel"]',
      )!;
      expect(cancel.getAttribute("aria-label")).toBe(`Cancel ${action}`);
      cancel.click();
      expect(card.dataset.confirmAction).toBeUndefined();
      expect(card.dataset.confirmReturning).toBe(action);
      expect(
        card.querySelector('[data-inline-comment-action="cancel"]'),
      ).toBeNull();
      expect(onResolve).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
    }
    expect(card.classList.contains("cm-inlineCommentAgent")).toBe(agent);
  });
  it("distinguishes agent comments and retains their provenance through anchor mapping", async () => {
    const origin = { provider: "codex" as const, sessionId: "session" };
    const agent: InlineEditorComment = {
      id: "agent",
      from: 0,
      to: 4,
      line: 1,
      text: "Agent review",
      origin,
    };
    const human: InlineEditorComment = {
      id: "human",
      from: 5,
      to: 9,
      line: 1,
      text: "Human review",
    };
    createView("some text", [agent, human]);
    expect(document.querySelectorAll(".cm-inlineCommentCard")).toHaveLength(2);
    expect(document.querySelectorAll(".cm-inlineCommentAgent")).toHaveLength(1);
    await vi.waitFor(() => {
      expect(
        document.querySelector(".cm-inlineCommentOrigin")?.textContent,
      ).toBe("Agent");
    });
    expect(
      document.querySelectorAll(".cm-inlineCommentAgentMark"),
    ).toHaveLength(1);
    expect(getInjectedStyleText()).toContain("background: #7252b5");
    expect(getInjectedStyleText()).toContain(
      "background: color-mix(in srgb, #7252b5 85%, black)",
    );
    expect(getInjectedStyleText()).toContain(
      "border-bottom: 2px solid #7252b5",
    );
    const changes = ChangeSet.of({ from: 0, insert: "prefix " }, 9);
    const mapped = mapInlineCommentsThroughChanges(
      [agent],
      changes,
      changes.apply(view!.state.doc).toString(),
      view!.state.doc.toString(),
    );
    expect(mapped[0].origin).toEqual(origin);
  });
  it("normalizes a selected range to the exact selected span", () => {
    const doc = "first line\nsecond line\nthird line";

    expect(normalizeInlineCommentRange(doc, 13, 18)).toEqual({
      from: 13,
      to: 18,
      line: 2,
    });
  });

  it("rejects full-document and very large comment ranges", () => {
    const doc = "first line\nsecond line\nthird line";
    const largeDoc = "x".repeat(25_000);

    expect(isInlineCommentRangeAllowed(doc.length, 0, doc.length)).toBe(false);
    expect(isInlineCommentRangeAllowed(largeDoc.length, 0, 20_001)).toBe(false);
    expect(isInlineCommentRangeAllowed(doc.length, 6, 17)).toBe(true);
  });

  it("renders a mark over the selected text and an inline card after the ending line", () => {
    createView("first line\nsecond line\nthird line", [
      {
        id: "comment-1",
        from: 11,
        to: 22,
        line: 2,
        text: "Clarify this claim.",
      },
    ]);

    expect(document.querySelector(".cm-inlineCommentMark")).not.toBeNull();
    expect(document.querySelector(".cm-inlineCommentMark")?.textContent).toBe(
      "second line",
    );
    expect(document.querySelector(".cm-inlineCommentAgentMark")).toBeNull();
    const markStyle =
      getInjectedStyleText().match(/\.cm-inlineCommentMark \{[^}]+\}/)?.[0] ??
      "";
    expect(markStyle).toContain(
      "background-color: color-mix(in oklab, var(--color-amber-300) 25%, transparent)",
    );
    expect(markStyle).toContain(
      "border-bottom: 2px solid color-mix(in oklab, var(--color-amber-500) 70%, transparent)",
    );
    expect(document.querySelector(".cm-inlineCommentText")?.textContent).toBe(
      "Clarify this claim.",
    );
    expect(
      document
        .querySelector(".cm-inlineCommentCard")
        ?.closest(".cm-line")
        ?.textContent?.includes("second line"),
    ).toBe(true);
  });

  it("keeps saved labels independent of row and display position", () => {
    createView("alpha beta gamma\ndelta epsilon zeta", [
      {
        id: "comment-2",
        number: 12,
        from: 11,
        to: 16,
        line: 1,
        text: "Second row-one comment.",
      },
      {
        id: "comment-1",
        number: 7,
        from: 6,
        to: 10,
        line: 1,
        text: "First row-one comment.",
      },
      {
        id: "comment-3",
        number: 3,
        origin: { provider: "codex", sessionId: "test" },
        from: 23,
        to: 30,
        line: 2,
        text: "First row-two comment.",
      },
    ]);

    expect(
      Array.from(document.querySelectorAll(".cm-inlineCommentSuperscript")).map(
        (superscript) => superscript.textContent,
      ),
    ).toEqual(["H-7", "H-12", "A-3"]);
    expect(
      Array.from(document.querySelectorAll(".cm-inlineCommentBadge")).map(
        (badge) => badge.textContent,
      ),
    ).toEqual(["H-7", "H-12", "A-3"]);
    expect(
      Array.from(document.querySelectorAll(".cm-inlineCommentText")).map(
        (card) => card.textContent,
      ),
    ).toEqual([
      "First row-one comment.",
      "Second row-one comment.",
      "First row-two comment.",
    ]);
  });

  it("centers the matching card when a highlight superscript is clicked", () => {
    createView("alpha beta gamma\ndelta epsilon zeta", [
      {
        id: "comment-1",
        from: 6,
        to: 10,
        line: 1,
        text: "First row-one comment.",
      },
    ]);

    const scroll = view?.scrollDOM;
    const card = document.querySelector<HTMLElement>(".cm-inlineCommentCard");
    const superscript = document.querySelector<HTMLButtonElement>(
      ".cm-inlineCommentSuperscript",
    );
    expect(scroll).toBeDefined();
    expect(card).not.toBeNull();
    expect(superscript).not.toBeNull();
    if (!scroll || !card || !superscript) return;

    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    scroll.scrollTop = 0;
    vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 100,
      left: 0,
      right: 200,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      top: 180,
      bottom: 220,
      left: 0,
      right: 200,
      width: 200,
      height: 40,
      x: 0,
      y: 180,
      toJSON: () => ({}),
    });

    superscript.click();

    expect(scroll.scrollTop).toBe(150);
  });

  it("maps comment ranges through insertions and deletions inside the highlight", () => {
    const doc = "alpha beta gamma";
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 6,
      to: 10,
      line: 1,
      text: "Comment on beta.",
    };
    const changes = ChangeSet.of(
      [
        { from: 8, insert: "wide " },
        { from: 9, to: 10 },
      ],
      doc.length,
    );
    const nextDoc = changes.apply(EditorState.create({ doc }).doc).toString();

    expect(
      mapInlineCommentsThroughChanges([comment], changes, nextDoc, doc),
    ).toEqual([
      {
        ...comment,
        from: 6,
        to: 14,
        line: 1,
      },
    ]);
  });

  it("does not include text inserted exactly at highlight anchors", () => {
    const doc = "alpha beta gamma";
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 6,
      to: 10,
      line: 1,
      text: "Comment on beta.",
    };
    const changes = ChangeSet.of(
      [
        { from: 6, insert: "new " },
        { from: 10, insert: "!" },
      ],
      doc.length,
    );
    const nextDoc = changes.apply(EditorState.create({ doc }).doc).toString();

    expect(
      mapInlineCommentsThroughChanges([comment], changes, nextDoc, doc),
    ).toEqual([
      {
        ...comment,
        from: 10,
        to: 14,
        line: 1,
      },
    ]);
    expect(nextDoc.slice(10, 14)).toBe("beta");
  });

  it("moves comment boundaries inward when boundary text is deleted", () => {
    const doc = "alpha beta gamma";
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 6,
      to: 10,
      line: 1,
      text: "Comment on beta.",
    };
    const changes = ChangeSet.of(
      [
        { from: 6, to: 7 },
        { from: 9, to: 10 },
      ],
      doc.length,
    );
    const nextDoc = changes.apply(EditorState.create({ doc }).doc).toString();

    expect(
      mapInlineCommentsThroughChanges([comment], changes, nextDoc, doc),
    ).toEqual([
      {
        ...comment,
        from: 6,
        to: 8,
        line: 1,
      },
    ]);
  });

  it("keeps fully deleted highlights anchored at the previous start position", () => {
    const doc = "alpha beta gamma";
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 6,
      to: 10,
      line: 1,
      text: "Comment on beta.",
    };
    const changes = ChangeSet.of({ from: 6, to: 10 }, doc.length);
    const nextDoc = changes.apply(EditorState.create({ doc }).doc).toString();

    expect(
      mapInlineCommentsThroughChanges([comment], changes, nextDoc, doc),
    ).toEqual([
      {
        ...comment,
        from: 6,
        to: 6,
        line: 1,
        removedAnchor: { text: "beta", from: 0, to: 4 },
        positionReset: true,
      },
    ]);
  });

  it("does not expand a small comment to the whole document after a full-document replacement", () => {
    const doc = "intro\nalpha beta gamma\noutro";
    const nextDoc = "intro\nalpha polished gamma\noutro";
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 12,
      to: 16,
      line: 2,
      text: "Comment on beta.",
    };
    const changes = ChangeSet.of(
      { from: 0, to: doc.length, insert: nextDoc },
      doc.length,
    );

    expect(
      mapInlineCommentsThroughChanges([comment], changes, nextDoc, doc),
    ).toEqual([
      {
        ...comment,
        positionReset: true,
        from: 0,
        to: 0,
        line: 1,
      },
    ]);
  });

  it("does not expand a contained comment to the whole replacement chunk", () => {
    const doc = "intro\nalpha beta gamma\noutro";
    const nextDoc = "intro\nalpha polished gamma\noutro";
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 12,
      to: 16,
      line: 2,
      text: "Comment on beta.",
    };
    const changes = ChangeSet.of(
      { from: 6, to: 22, insert: "alpha polished gamma" },
      doc.length,
    );

    expect(
      mapInlineCommentsThroughChanges([comment], changes, nextDoc, doc),
    ).toEqual([
      {
        ...comment,
        positionReset: true,
        from: 6,
        to: 6,
        line: 2,
      },
    ]);
  });

  it("preserves the left outside portion for a right-overlapping edit", () => {
    const doc = "intro\nalpha beta gamma\noutro";
    const nextDoc = "intro\nalpha bepolished\noutro";
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 12,
      to: 16,
      line: 2,
      text: "Comment on beta.",
    };
    const changes = ChangeSet.of(
      { from: 14, to: 22, insert: "polished" },
      doc.length,
    );

    expect(
      mapInlineCommentsThroughChanges([comment], changes, nextDoc, doc),
    ).toEqual([
      {
        ...comment,
        from: 12,
        to: 14,
        line: 2,
      },
    ]);
  });

  it("preserves the right outside portion for a left-overlapping edit", () => {
    const doc = "intro\nalpha beta gamma\noutro";
    const nextDoc = "intro\nalpha polishedta gamma\noutro";
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 12,
      to: 16,
      line: 2,
      text: "Comment on beta.",
    };
    const changes = ChangeSet.of(
      { from: 6, to: 14, insert: "alpha polished" },
      doc.length,
    );

    expect(
      mapInlineCommentsThroughChanges([comment], changes, nextDoc, doc),
    ).toEqual([
      {
        ...comment,
        from: 20,
        to: 22,
        line: 2,
      },
    ]);
  });

  it("keeps a fully replaced comment at the replacement boundary without passage searching", () => {
    const doc = "intro\nalpha beta gamma\noutro";
    const nextDoc = "preface\nintro\nalpha beta gamma\noutro";
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 12,
      to: 16,
      line: 2,
      text: "Comment on beta.",
    };
    const changes = ChangeSet.of(
      { from: 0, to: doc.length, insert: nextDoc },
      doc.length,
    );

    expect(
      mapInlineCommentsThroughChanges([comment], changes, nextDoc, doc),
    ).toEqual([
      {
        ...comment,
        positionReset: true,
        from: 0,
        to: 0,
        line: 1,
      },
    ]);
  });

  it("does not reanchor a comment to a partial word match after a full-document replacement", () => {
    const doc = "intro\nHarness line 3\nHarness line 30";
    const nextDoc = "intro\nHarness polished sentence three\nHarness line 30";
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 14,
      to: 20,
      line: 2,
      text: "Comment on line 3.",
    };
    const changes = ChangeSet.of(
      { from: 0, to: doc.length, insert: nextDoc },
      doc.length,
    );

    expect(
      mapInlineCommentsThroughChanges([comment], changes, nextDoc, doc),
    ).toEqual([
      {
        ...comment,
        positionReset: true,
        from: 0,
        to: 0,
        line: 1,
      },
    ]);
  });

  it("renders collapsed comments as anchored markers with their cards", () => {
    createView("alpha gamma", [
      {
        id: "comment-1",
        from: 6,
        to: 6,
        line: 1,
        text: "Comment on removed text.",
      },
    ]);

    expect(document.querySelector(".cm-inlineCommentMark")).toBeNull();
    expect(document.querySelector(".cm-inlineCommentSuperscript")).toBeNull();
    expect(
      document.querySelector('[data-comment-range-handle="point"]'),
    ).not.toBeNull();
    expect(document.querySelector(".cm-inlineCommentText")?.textContent).toBe(
      "Comment on removed text.",
    );
  });

  it("calls edit and requires confirmation to delete a saved comment", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    createView(
      "first line\nsecond line\nthird line",
      [
        {
          id: "comment-1",
          from: 11,
          to: 22,
          line: 2,
          text: "Clarify this claim.",
        },
      ],
      { onEdit, onDelete },
    );

    document
      .querySelector<HTMLButtonElement>('[data-inline-comment-action="edit"]')
      ?.click();

    expect(onEdit).toHaveBeenCalledWith("comment-1");
    expect(onDelete).not.toHaveBeenCalled();
    const clickDelete = () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-inline-comment-action="delete"]',
        )
        ?.click();
    clickDelete();
    expect(onDelete).not.toHaveBeenCalled();
    document.body.click();
    expect(
      document.querySelector('[data-inline-comment-action="confirm-delete"]'),
    ).toBeNull();
    clickDelete();
    document
      .querySelector<HTMLButtonElement>(
        '[data-inline-comment-action="confirm-delete"]',
      )
      ?.click();
    expect(onDelete).toHaveBeenCalledWith("comment-1");
  });

  it("reuses the card DOM while transitioning between read and edit states", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const comments = new Compartment();
    const comment: InlineEditorComment = {
      id: "comment-1",
      from: 11,
      to: 22,
      line: 2,
      text: "Clarify this claim.",
      createdAt: "2026-07-04T12:00:00",
    };
    const actions = {
      onDelete: vi.fn(),
      onEdit: vi.fn(),
      onResolve: vi.fn(),
      onSave: vi.fn(),
    };
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "first line\nsecond line\nthird line",
        extensions: [
          comments.of(createInlineCommentExtension([comment], actions)),
        ],
      }),
    });

    const initialCard = document.querySelector<HTMLElement>(
      ".cm-inlineCommentCard",
    );
    expect(initialCard).not.toBeNull();
    initialCard?.setAttribute("data-dom-identity", "preserved");
    // Header buttons contribute six pixels to the card's natural height.
    if (!initialCard) throw new Error("Missing comment card");
    vi.spyOn(initialCard, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          height: initialCard.querySelector(".cm-inlineCommentControls")
            ? 89
            : 83,
        }) as DOMRect,
    );

    view.dispatch({
      effects: comments.reconfigure(
        createInlineCommentExtension(
          [{ ...comment, isEditing: true }],
          actions,
        ),
      ),
    });

    const updatedCard = document.querySelector<HTMLElement>(
      ".cm-inlineCommentCard",
    );
    expect(updatedCard).toBe(initialCard);
    expect(updatedCard?.style.height).toBe("89px");
    expect(updatedCard?.dataset.domIdentity).toBe("preserved");
    expect(updatedCard?.classList).toContain("cm-inlineCommentCardEditing");
    expect(updatedCard?.classList).toContain(
      "cm-inlineCommentCardTransitioning",
    );
    expect(
      updatedCard?.querySelector(".cm-inlineCommentControls")?.classList,
    ).toContain("cm-inlineCommentControlsTransitioningPrimary");
    expect(
      updatedCard?.querySelector(".cm-inlineCommentBodyLeaving"),
    ).not.toBeNull();
    expect(
      updatedCard?.querySelector(".cm-inlineCommentBodyEntering"),
    ).not.toBeNull();
    expect(
      updatedCard?.querySelector(".cm-inlineCommentBackgroundWipe"),
    ).not.toBeNull();
    expect(
      updatedCard?.querySelector<HTMLTextAreaElement>(
        '[data-inline-comment-input="comment"]',
      )?.value,
    ).toBe("Clarify this claim.");
    expect(getInlineCommentTransitioningCardStyleRule()).toContain(
      "height 160ms cubic-bezier(0.2, 0.8, 0.2, 1)",
    );
    expect(getInlineCommentContentStyleRule()).toContain("display: grid");
    expect(getInlineCommentContentStyleRule()).toContain("margin: 0 -10px");
    expect(getInlineCommentContentStyleRule()).toContain(
      "width: calc(100% + 20px)",
    );
    const styles = getInjectedStyleText();
    expect(styles).toContain("transform: scaleX(0)");
    expect(styles).toContain("transform: scaleX(1)");
    expect(styles).toContain("transform-origin: left center");
    expect(styles).toContain("transition: transform 160ms linear");
    expect(styles).not.toContain("transform: translateX(6px)");
    expect(styles).not.toContain("transform: translateX(-6px)");

    const focusedEditor = updatedCard?.querySelector<HTMLTextAreaElement>(
      '[data-inline-comment-input="comment"]',
    );
    focusedEditor?.focus();
    const finishedTransition = new Event("transitionend");
    Object.defineProperty(finishedTransition, "propertyName", {
      value: "height",
    });
    updatedCard?.dispatchEvent(finishedTransition);
    expect(document.activeElement).toBe(focusedEditor);

    view.dispatch({
      effects: comments.reconfigure(
        createInlineCommentExtension([comment], actions),
      ),
    });
    expect(document.querySelector(".cm-inlineCommentCard")).toBe(initialCard);
    expect(initialCard.style.height).toBe("89px");
    expect(initialCard.classList).not.toContain("cm-inlineCommentCardEditing");
    expect(
      initialCard.querySelector(".cm-inlineCommentControls")?.classList,
    ).toContain("cm-inlineCommentControlsTransitioningPrimary");
    const returningControls = initialCard.querySelector(
      ".cm-inlineCommentControls",
    );
    view.dispatch({
      effects: comments.reconfigure(
        createInlineCommentExtension([{ ...comment, number: 42 }], actions),
      ),
    });
    expect(initialCard.querySelector(".cm-inlineCommentControls")).toBe(
      returningControls,
    );
    expect(returningControls?.classList).toContain(
      "cm-inlineCommentControlsTransitioningPrimary",
    );
    expect(
      initialCard.querySelector(".cm-inlineCommentBadge")?.textContent,
    ).toBe("H-42");
  });

  it("renders saved comment metadata and resolves from the check button", () => {
    const onResolve = vi.fn();
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    createView(
      "first line\nsecond line\nthird line",
      [
        {
          id: "comment-1",
          from: 11,
          to: 22,
          line: 2,
          text: "Clarify this claim.",
          createdAt: "2026-07-04T12:00:00",
        },
      ],
      { onDelete, onEdit, onResolve },
    );

    expect(document.querySelector(".cm-inlineCommentTime")?.textContent).toBe(
      "Jul 4, 2026, 12:00 PM",
    );
    expect(getInlineCommentTimeStyleRule()).toContain("font-size: 10px");
    expect(getInlineCommentTimeStyleRule()).toContain("font-weight: 700");
    expect(getInlineCommentCardStyleRule()).toContain(
      "width: calc(100% + 10px)",
    );
    expect(getInlineCommentCardStyleRule()).toContain(
      "margin: 6px 0 10px -10px",
    );
    expect(getInlineCommentCardStyleRule()).toContain("border-radius: 12px");
    expect(getInlineCommentCardStyleRule()).toContain("padding: 12px 10px 0");
    expect(getInlineCommentHeaderStyleRule()).toContain(
      "border-bottom: 1px solid color-mix(in oklch, #fffbeb 34%, transparent)",
    );
    expect(getInlineCommentHeaderStyleRule()).toContain("margin-bottom: 0");
    expect(getInlineCommentHeaderStyleRule()).toContain("padding-bottom: 8px");
    expect(getInlineCommentTextStyleRule()).toContain("font-size: 14px");
    expect(getInlineCommentTextStyleRule()).toContain("flex: 1 1 0");
    expect(getInlineCommentTextStyleRule()).toContain("font-weight: 500");
    expect(getInlineCommentTextStyleRule()).toContain("line-height: 20px");
    expect(getInlineCommentTextStyleRule()).toContain("margin: 0");
    expect(getInlineCommentTextStyleRule()).toContain("padding-right: 0");
    expect(getInlineCommentBodyStyleRule()).toContain("display: block");
    expect(getInlineCommentBodyStyleRule()).toContain("position: relative");
    expect(getInlineCommentBodyStyleRule()).toContain("padding-top: 12px");
    expect(getInlineCommentBodyStyleRule()).toContain("padding-bottom: 12px");
    expect(getInlineCommentControlsStyleRule()).toContain(
      "border-radius: 12px",
    );
    expect(getInlineCommentControlsStyleRule()).toContain("flex: 0 0 auto");
    expect(getInlineCommentControlsStyleRule()).toContain("gap: 6px");
    expect(getInlineCommentControlsStyleRule()).toContain("overflow: hidden");
    expect(getInlineCommentControlsStyleRule()).toContain("padding: 0");
    expect(getInlineCommentControlsStyleRule()).not.toContain(
      "position: absolute",
    );
    expect(getInlineCommentControlsStyleRule()).toContain(
      "transition: background 120ms ease-out, box-shadow 120ms ease-out",
    );
    expect(getInlineCommentButtonStyleRule()).toContain("border-radius: 0");
    expect(getInlineCommentButtonStyleRule()).toContain(
      "box-sizing: border-box",
    );
    expect(getInlineCommentButtonStyleRule()).toContain(
      "transition: background 120ms ease-out, color 120ms ease-out, opacity 120ms ease-out, transform 120ms ease-out",
    );
    expect(getInlineCommentButtonStyleRule()).toContain("height: 24px");
    expect(getInlineCommentButtonStyleRule()).toContain("width: 24px");
    expect(getInlineCommentButtonStyleRule()).toContain("padding: 0");
    expect(getInlineCommentFirstButtonStyleRule()).toContain(
      "padding-left: 4px",
    );
    expect(getInlineCommentFirstButtonStyleRule()).toContain("width: 28px");
    expect(getInlineCommentLastButtonStyleRule()).toContain(
      "padding-right: 4px",
    );
    expect(getInlineCommentLastButtonStyleRule()).toContain("width: 28px");
    expect(getInlineCommentIconStyleRule()).toContain("height: 14px");
    expect(getInlineCommentIconStyleRule()).toContain("width: 14px");

    const actionButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".cm-inlineCommentControls .cm-inlineCommentButton:not([data-inline-comment-action=copy])",
      ),
    );
    expect(
      actionButtons.map((button) => button.dataset.inlineCommentAction),
    ).toEqual(["delete", "edit", "resolve"]);
    expect(
      document.querySelector('[data-inline-comment-action="delete"]'),
    ).not.toBeNull();
    const header = document.querySelector(".cm-inlineCommentHeader");
    const body = document.querySelector(".cm-inlineCommentBody");
    const time = document.querySelector(".cm-inlineCommentTime");
    const controls = document.querySelector(".cm-inlineCommentControls");
    const primaryGroup = controls?.querySelector(
      ".cm-inlineCommentPrimaryControls",
    );
    expect(primaryGroup?.querySelectorAll("button")).toHaveLength(2);
    expect(
      controls?.querySelector('[data-inline-comment-action="delete"]')
        ?.parentElement,
    ).toBe(controls);
    const text = document.querySelector(".cm-inlineCommentText");
    expect(header?.contains(time)).toBe(true);
    expect(header?.contains(controls)).toBe(true);
    expect(body?.contains(text)).toBe(true);
    expect(body?.contains(controls)).toBe(false);
    expect(
      actionButtons.map(
        (button) => button.querySelector(".cm-inlineCommentIcon")?.tagName,
      ),
    ).toEqual(["svg", "svg", "svg"]);
    expect(
      Array.from(actionButtons[1]?.querySelectorAll("path") ?? []).map((path) =>
        path.getAttribute("d"),
      ),
    ).toEqual(["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"]);
    expect(actionButtons.map((button) => button.textContent)).toEqual([
      "",
      "",
      "",
    ]);

    const resolveButton = document.querySelector<HTMLButtonElement>(
      '[data-inline-comment-action="resolve"]',
    );
    expect(resolveButton?.getAttribute("aria-label")).toBe("Resolve comment");
    resolveButton?.click();
    expect(onResolve).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-inline-comment-action="confirm-resolve"]')
        ?.textContent,
    ).toBe("Resolve");
    expect(
      document.querySelector(".cm-inlineCommentControlsConfirmingResolve"),
    ).not.toBeNull();
    document.body.click();
    expect(
      document.querySelector('[data-inline-comment-action="confirm-resolve"]'),
    ).toBeNull();
    expect(onResolve).not.toHaveBeenCalled();
    document
      .querySelector<HTMLButtonElement>(
        '[data-inline-comment-action="resolve"]',
      )
      ?.click();
    document
      .querySelector<HTMLButtonElement>(
        '[data-inline-comment-action="confirm-resolve"]',
      )
      ?.click();
    expect(onResolve).toHaveBeenCalledWith("comment-1");
  });

  it("uses a flat saturated yellow palette for inline comment cards", () => {
    createView("first line\nsecond line\nthird line", [
      {
        id: "comment-1",
        from: 11,
        to: 22,
        line: 2,
        text: "Clarify this claim.",
      },
    ]);

    const cardRule = getInlineCommentCardStyleRule();
    expect(cardRule).toContain("background: #eab308");
    expect(cardRule).toContain("color: #fff7ed");
    expect(cardRule).toContain("overflow: hidden");
    expect(cardRule).not.toContain("linear-gradient");
    expect(cardRule).not.toContain("border:");

    expect(getInlineCommentTimeStyleRule()).toContain("color: #fffbeb");
  });

  it("saves an inline draft on Enter and inserts a newline on Command+Enter", () => {
    const onSave = vi.fn();
    const onDelete = vi.fn();
    createView(
      "first line\nsecond line\nthird line",
      [
        {
          id: "comment-1",
          from: 11,
          to: 22,
          line: 2,
          text: "",
          createdAt: "2026-07-04T12:00:00",

          isEditing: true,
        },
      ],
      { onDelete, onSave },
    );

    const editor = document.querySelector<HTMLTextAreaElement>(
      '[data-inline-comment-input="comment"]',
    );
    expect(editor).not.toBeNull();
    if (!editor) return;
    expect(
      document.querySelector(".cm-inlineCommentCard")?.className,
    ).toContain("cm-inlineCommentCardEditing");
    expect(getInlineCommentEditBodyStyleRule()).toContain("display: block");
    expect(
      document
        .querySelector(".cm-inlineCommentHeader")
        ?.contains(document.querySelector(".cm-inlineCommentControls")),
    ).toBe(true);
    expect(getInlineCommentEditBodyStyleRule()).toContain("position: relative");
    expect(getInlineCommentEditorStyleRule()).toContain(
      "background: transparent",
    );
    expect(getInlineCommentEditorStyleRule()).toContain("border-radius: 0");
    expect(getInlineCommentEditorStyleRule()).toContain("display: block");
    expect(getInlineCommentEditorStyleRule()).toContain("font-size: 14px");
    expect(getInlineCommentEditorStyleRule()).toContain("font-weight: 500");
    expect(getInlineCommentEditorStyleRule()).toContain("line-height: 20px");
    expect(getInlineCommentEditorStyleRule()).toContain("margin: 0");
    expect(getInlineCommentEditorStyleRule()).toContain("overflow: hidden");
    expect(getInlineCommentEditorStyleRule()).toContain("padding: 12px 10px");
    expect(getInlineCommentEditorStyleRule()).toContain(
      "white-space: pre-wrap",
    );
    expect(getInlineCommentEditorStyleRule()).toContain(
      "overflow-wrap: break-word",
    );
    expect(getInlineCommentEditorStyleRule()).toContain("width: 100%");
    expect(getInlineCommentEditingHeaderStyleRule()).toContain(
      "border-bottom: 1px solid transparent",
    );
    const editActionButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".cm-inlineCommentControls .cm-inlineCommentButton:not([data-inline-comment-action=copy])",
      ),
    );
    expect(editActionButtons.map((button) => button.textContent)).toEqual([
      "",
      "Cancel",
    ]);
    expect(editActionButtons[1]?.getAttribute("aria-label")).toBe(
      "Cancel comment",
    );
    editor.value = "First line";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    expect(
      editActionButtons.map((button) => button.dataset.inlineCommentAction),
    ).toEqual(["delete", "save"]);
    expect(
      editActionButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Delete comment", "Save comment"]);
    const saveButton = editActionButtons.find(
      (button) => button.dataset.inlineCommentAction === "save",
    );
    expect(saveButton?.querySelector("svg")).toBeNull();
    expect(editActionButtons.map((button) => button.textContent)).toEqual([
      "",
      "Save",
    ]);
    expect(saveButton?.classList).toContain("cm-inlineCommentSaveButton");
    expect(getInlineCommentEditingControlsStyleRule()).toContain(
      "box-shadow: none",
    );

    editor.value = "First line";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
      }),
    );
    editor.value = "First line\nSecond line";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    expect(onSave).toHaveBeenCalledWith("comment-1", "First line\nSecond line");

    editor.value = "Saved from button";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editActionButtons
      .find((button) => button.dataset.inlineCommentAction === "save")
      ?.click();
    editActionButtons
      .find((button) => button.dataset.inlineCommentAction === "delete")
      ?.click();

    expect(onSave).toHaveBeenCalledWith("comment-1", "Saved from button");
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("requires a second confirmation click before deleting an edited comment", () => {
    const onDelete = vi.fn();
    const onSave = vi.fn();
    createView(
      "first line\nsecond line\nthird line",
      [
        {
          id: "comment-1",
          from: 11,
          to: 22,
          line: 2,
          text: "Draft comment.",
          createdAt: "2026-07-04T12:00:00",

          isEditing: true,
        },
      ],
      { onDelete, onSave },
    );

    document
      .querySelector<HTMLButtonElement>('[data-inline-comment-action="delete"]')
      ?.click();

    expect(onDelete).not.toHaveBeenCalled();
    expect(getInlineCommentDeleteConfirmControlsStyleRule()).toContain(
      "--comment-control-background: rgba(0, 0, 0, 0.15)",
    );
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".cm-inlineCommentControls .cm-inlineCommentButton:not([data-inline-comment-action=copy])",
        ),
      ).map((button) => button.dataset.inlineCommentAction),
    ).toEqual(["cancel"]);
    const confirmButton = document.querySelector<HTMLButtonElement>(
      '[data-inline-comment-action="confirm-delete"]',
    );
    expect(confirmButton?.textContent).toBe("Delete");
    expect(getInlineCommentDeleteConfirmStyleRule()).toContain("padding: 0");
    expect(getInlineCommentDeleteConfirmStyleRule()).toContain(
      "transition: background 120ms ease-out, color 120ms ease-out, opacity 120ms ease-out, transform 120ms ease-out",
    );
    expect(getInlineCommentDeleteConfirmStyleRule()).toContain("width: 56px");
    expect(getInlineCommentTransitioningDeleteConfirmStyleRule()).toContain(
      "transform: translateX(-100%)",
    );

    confirmButton?.click();

    expect(onDelete).toHaveBeenCalledWith("comment-1");
  });

  it("restores edit controls when delete confirmation loses focus by outside click", () => {
    const onDelete = vi.fn();
    const onSave = vi.fn();
    createView(
      "first line\nsecond line\nthird line",
      [
        {
          id: "comment-1",
          from: 11,
          to: 22,
          line: 2,
          text: "Draft comment.",
          createdAt: "2026-07-04T12:00:00",

          isEditing: true,
        },
      ],
      { onDelete, onSave },
    );

    document
      .querySelector<HTMLButtonElement>('[data-inline-comment-action="delete"]')
      ?.click();
    document.body.click();

    expect(onDelete).not.toHaveBeenCalled();
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".cm-inlineCommentControls .cm-inlineCommentButton:not([data-inline-comment-action=copy])",
        ),
      ).map((button) => button.dataset.inlineCommentAction),
    ).toEqual(["delete", "save"]);
    expect(
      document.querySelector('[data-inline-comment-action="confirm-delete"]'),
    ).toBeNull();
  });

  it("sizes the edit textarea from wrapped content instead of hard newline rows", () => {
    const editorView = createView(
      "first line\nsecond line\nthird line",
      [
        {
          id: "comment-1",
          from: 11,
          to: 22,
          line: 2,
          text: "First line\nSecond line\nThird line",
          createdAt: "2026-07-04T12:00:00",
          isEditing: true,
        },
      ],
      {},
    );

    const editor = document.querySelector<HTMLTextAreaElement>(
      '[data-inline-comment-input="comment"]',
    );
    expect(editor).not.toBeNull();
    if (!editor) return;
    expect(editor?.rows).toBe(1);
    expect(getInlineCommentEditorStyleRule()).toContain("padding: 12px 10px");

    const requestMeasure = vi.spyOn(editorView, "requestMeasure");
    editor.value = "First line\nSecond line\nThird line\nFourth line";
    editor.dispatchEvent(new Event("input", { bubbles: true }));

    expect(requestMeasure).toHaveBeenCalled();
  });
});

it("reuses transaction states without allocating replacement editor states", () => {
  const previous = EditorState.create({ doc: "alpha beta" });
  const transaction = previous.update({ changes: { from: 0, insert: "new " } });
  const next = transaction.state;
  const create = vi.spyOn(EditorState, "create");
  try {
    expect(
      mapComments(
        [{ id: "mapped", from: 6, to: 10, line: 1, text: "Keep beta" }],
        transaction.changes,
        next,
        previous,
      ),
    ).toEqual([{ id: "mapped", from: 10, to: 14, line: 1, text: "Keep beta" }]);
    expect(create).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
  }
});

describe("stale persisted comment anchors", () => {
  it.each([
    true,
    false,
  ])("maps out-of-range anchors with previous document = %s", (withPrevious) => {
    const doc = "alpha\nbeta";
    const state = EditorState.create({ doc });
    const transaction = state.update({ changes: { from: 0, insert: "New " } });
    const comments: InlineEditorComment[] = [
      {
        id: "resolved",
        from: 139686,
        to: 139686,
        line: 1772,
        text: "Resolved note",
        resolved: true,
      },
      {
        id: "agent",
        from: 138191,
        to: 138352,
        line: 1700,
        text: "Agent note",
        origin: { provider: "codex", sessionId: "test" },
      },
      { id: "negative", from: -8, to: -2, line: 0, text: "Old note" },
    ];
    const result = mapInlineCommentsThroughChanges(
      comments,
      transaction.changes,
      transaction.state.doc.toString(),
      withPrevious ? doc : undefined,
    );
    expect(result.slice(0, 2)).toEqual(
      comments.slice(0, 2).map((comment) => ({
        ...comment,
        from: transaction.state.doc.length,
        to: transaction.state.doc.length,
        line: 2,
        positionReset: true,
      })),
    );
    expect(result[2].from).toBeGreaterThanOrEqual(0);
    expect(result[2].to).toBeLessThanOrEqual(transaction.state.doc.length);
  });
});

it("restores the original range when an exact deletion is undone", () => {
  const source = "before target after";
  const original = { id: "undo", from: 7, to: 13, line: 1, text: "Keep me" };
  const deletion = ChangeSet.of({ from: 0, to: source.length }, source.length);
  const point = mapComments([original], deletion, "", source)[0];
  expect(point).toMatchObject({ from: 0, to: 0 });
  expect(point.positionReset).toBe(true);
  const restored = mapComments(
    [point],
    deletion.invert(EditorState.create({ doc: source }).doc),
    source,
    "",
  )[0];
  expect(restored).toMatchObject(original);
  expect(restored.positionReset).toBeUndefined();
  expect(restored.removedAnchor).toBeUndefined();
  expect(mapComments([restored], deletion, "", source)[0]).toEqual(point);
});

it("does not restore an invalid deleted-range record", () => {
  const point = {
    id: "bad",
    from: 0,
    to: 0,
    line: 1,
    text: "Keep me",
    removedAnchor: { text: "x", from: -1, to: 99 },
  };
  expect(
    mapComments([point], ChangeSet.of({ from: 0, insert: "x" }, 0), "x", "")[0],
  ).toMatchObject({ from: 1, to: 1 });
});

it("keeps the range overlay alive and forwards actions to the current anchor", () => {
  const first = vi.fn();
  const latest = vi.fn();
  const comment = { id: "stable", from: 1, to: 3, line: 1, text: "Review" };
  const editor = createView("text", [comment], { onAttach: first });
  const overlay = editor.dom.querySelector("[data-comment-range-overlay]");
  editor.dispatch({ changes: { from: 0, insert: "prefix " } });
  editor.dispatch({
    effects: updateInlineCommentsEffect.of({
      comments: [{ ...comment, from: 8, to: 10 }],
      actions: { onAttach: latest },
    }),
  });
  expect(editor.dom.querySelector("[data-comment-range-overlay]")).toBe(
    overlay,
  );
  editor.dom
    .querySelector<HTMLButtonElement>(".cm-inlineCommentAttach")!
    .click();
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledWith(
    expect.objectContaining({ from: 8, to: 10 }),
  );
});

it("does not publish a speculative transaction's comment state", () => {
  const attach = vi.fn();
  const comment = { id: "stable", from: 1, to: 3, line: 1, text: "Review" };
  const editor = createView("text", [comment], { onAttach: attach });
  editor.state.update({
    effects: updateInlineCommentsEffect.of({ comments: [], actions: {} }),
  });
  editor.dom
    .querySelector<HTMLButtonElement>(".cm-inlineCommentAttach")!
    .click();
  expect(attach).toHaveBeenCalledWith(comment);
});

it("shares saving state across mounted cards without blocking another comment", async () => {
  const { InlineCommentCardWidget } = await import("./inline-comments");
  const { trackCommentSaving } = await import("./comment-save-state");
  const scope = { root: "/card-saving", filePath: "main.tex" };
  const onSave = vi.fn();
  const onDelete = vi.fn();
  const comment = {
    id: "saving",
    from: 0,
    to: 4,
    line: 1,
    text: "Draft",
    isEditing: true,
  };
  const actions = { historyScope: scope, onSave, onDelete, onEdit: vi.fn() };
  const widget = new InlineCommentCardWidget(comment, 0, actions);
  const mirror = new InlineCommentCardWidget(
    { ...comment, isEditing: false },
    0,
    actions,
  );
  const other = new InlineCommentCardWidget(
    { ...comment, id: "other" },
    1,
    actions,
  );
  const layout = { requestMeasure() {} };
  const cards = [
    widget.toDOM(layout),
    mirror.toDOM(layout),
    other.toDOM(layout),
  ];
  document.body.append(...cards);
  const setSaving = trackCommentSaving(scope.root, comment.id);
  try {
    cards[1]
      .querySelector<HTMLButtonElement>(
        '[data-inline-comment-action="delete"]',
      )!
      .click();
    expect(
      cards[1].querySelector('[data-inline-comment-action="confirm-delete"]'),
    ).not.toBeNull();
    setSaving(true);
    document.body.click();
    expect(
      cards[1].querySelector('[data-inline-comment-action="confirm-delete"]'),
    ).toBeNull();
    expect(cards[0].querySelector("textarea")?.readOnly).toBe(true);
    expect(cards[0].querySelector(".cm-inlineCommentSaving")?.textContent).toBe(
      "Saving…",
    );
    expect(cards[1].querySelector(".cm-inlineCommentSaving")?.textContent).toBe(
      "Saving…",
    );
    expect(cards[2].querySelector("textarea")?.readOnly).toBe(false);
    cards[0]
      .querySelector("textarea")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    cards[1]
      .querySelector<HTMLButtonElement>(
        '[data-inline-comment-action="delete"]',
      )!
      .click();
    expect(onSave).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    setSaving(false);
    expect(cards[0].querySelector("textarea")?.value).toBe("Draft");
    expect(cards[0].querySelector("textarea")?.readOnly).toBe(false);
    expect(
      cards[0].querySelector(".cm-inlineCommentSaveButton")?.textContent,
    ).toBe("Save");
    expect(
      cards[1].querySelector<HTMLButtonElement>(
        '[data-inline-comment-action="edit"]',
      )?.disabled,
    ).toBe(false);
  } finally {
    setSaving(false);
    [widget, mirror, other].forEach((item, index) => {
      item.destroy(cards[index]);
      cards[index].remove();
    });
  }
});

it.each([
  false,
  true,
])("restores unplaced actions after saving and placement undo (agent=%s)", async (agent) => {
  const { InlineCommentCardWidget } = await import("./inline-comments");
  const { trackCommentSaving } = await import("./comment-save-state");
  const comment: InlineEditorComment = {
    id: "unplaced-actions",
    number: 3,
    from: 2,
    to: 2,
    line: 1,
    text: "Keep this feedback",
    positionReset: true,
    ...(agent
      ? { origin: { provider: "codex", sessionId: "session" } as const }
      : {}),
  };
  const actions = {
    historyScope: { root: "/unplaced-actions", filePath: "main.tex" },
    onEdit: vi.fn(),
    onResolve: vi.fn(),
    onDelete: vi.fn(),
    onAttach: vi.fn(),
  };
  const layout = { requestMeasure: vi.fn() };
  let widget = new InlineCommentCardWidget(comment, 0, actions);
  const card = widget.toDOM(layout);
  document.body.appendChild(card);
  const action = (name: string) =>
    card.querySelector<HTMLButtonElement>(
      `[data-inline-comment-action="${name}"]`,
    );
  const assertUnplaced = () => {
    expect(card.querySelector(".cm-inlineCommentBadge")?.textContent).toBe(
      agent ? "A-3" : "H-3",
    );
    expect(
      card.querySelector(".cm-inlineCommentPlacementStatus")?.textContent,
    ).toBe("Lost");
    expect(action("place")).toBeNull();
    expect(
      card.querySelector(".cm-inlineCommentPlacementStatus")?.tagName,
    ).toBe("SPAN");
    expect(action("edit")).toBeNull();
    expect(action("resolve")).toBeNull();
    expect(action("delete")).not.toBeNull();
    expect(
      card.querySelector(
        ".cm-inlineCommentTime .cm-inlineCommentPlacementHint",
      ),
    ).not.toBeNull();
    expect(card.lastElementChild?.className).not.toBe(
      "cm-inlineCommentPlacementHint",
    );
  };
  assertUnplaced();
  card.querySelector<HTMLButtonElement>(".cm-inlineCommentAttach")!.click();
  expect(document.activeElement).toBe(card);
  expect(actions.onAttach).toHaveBeenCalledOnce();
  const saving = trackCommentSaving(actions.historyScope.root, comment.id);
  try {
    saving(true);
    expect(card.querySelector(".cm-inlineCommentPlacementStatus")).toBeNull();
    expect(card.querySelector(".cm-inlineCommentSaving")).not.toBeNull();
    saving(false);
    assertUnplaced();
    const placed = new InlineCommentCardWidget(
      { ...comment, to: 6, positionReset: undefined },
      0,
      actions,
    );
    expect(placed.updateDOM(card, layout)).toBe(true);
    widget = placed;
    expect(card.querySelector(".cm-inlineCommentPlacementStatus")).toBeNull();
    expect(action("edit")).not.toBeNull();
    expect(action("resolve")).not.toBeNull();
    expect(card.querySelector(".cm-inlineCommentPlacementHint")).not.toBeNull();
    expect(card.classList.contains("cm-inlineCommentUnplaced")).toBe(false);
    const retainedHint = card.querySelector(".cm-inlineCommentPlacementHint");
    const undone = new InlineCommentCardWidget(comment, 0, actions);
    expect(undone.updateDOM(card, layout)).toBe(true);
    widget = undone;
    assertUnplaced();
    expect(card.querySelector(".cm-inlineCommentPlacementHint")).toBe(
      retainedHint,
    );
    action("delete")!.click();
    expect(action("confirm-delete")).not.toBeNull();
    const shifted = new InlineCommentCardWidget(
      { ...comment, from: 3, to: 3 },
      0,
      actions,
    );
    expect(shifted.updateDOM(card, layout)).toBe(true);
    widget = shifted;
    expect(action("confirm-delete")).not.toBeNull();
    document.body.click();
    assertUnplaced();
    expect(actions.onDelete).not.toHaveBeenCalled();
  } finally {
    saving(false);
    widget.destroy(card);
  }
});

it("copies current text while saving, retries failure, and ignores stale or disposed completions", async () => {
  const { InlineCommentCardWidget } = await import("./inline-comments");
  const { trackCommentSaving } = await import("./comment-save-state");
  const { toast } = await import("sonner");
  const previousClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: write },
  });
  const showError = vi.spyOn(toast, "error").mockReturnValue("copy-error");
  vi.useFakeTimers();
  const comment: InlineEditorComment = {
    id: "copy",
    number: 1,
    from: 0,
    to: 4,
    line: 1,
    text: "Only the comment\nnot its ID",
    positionReset: true,
  };
  const actions = {
    historyScope: { root: "/copy-card", filePath: "main.tex" },
    onAttach: vi.fn(),
    onSave: vi.fn(),
  };
  let widget = new InlineCommentCardWidget(comment, 0, actions);
  const layout = { requestMeasure() {} };
  const card = widget.toDOM(layout);
  document.body.appendChild(card);
  const copy = card.querySelector<HTMLButtonElement>(
    ".cm-inlineCommentCopyButton",
  )!;
  const saving = trackCommentSaving(actions.historyScope.root, comment.id);
  try {
    saving(true);
    copy.click();
    await Promise.resolve();
    expect(write).toHaveBeenLastCalledWith(comment.text);
    expect(copy.getAttribute("aria-label")).toBe("Copied comment text");
    expect(actions.onAttach).not.toHaveBeenCalled();
    expect(actions.onSave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(copy.getAttribute("aria-label")).toBe("Copy comment text");
    saving(false);
    write.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    copy.click();
    await Promise.resolve();
    expect(copy.getAttribute("aria-label")).toBe("Copy failed — try again");
    expect(showError).toHaveBeenCalledOnce();
    copy.click();
    await Promise.resolve();
    expect(copy.getAttribute("aria-label")).toBe("Copied comment text");
    let release!: () => void;
    write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    copy.click();
    const changed = new InlineCommentCardWidget(
      { ...comment, text: "Updated content" },
      0,
      actions,
    );
    expect(changed.updateDOM(card, layout)).toBe(true);
    widget = changed;
    release();
    await Promise.resolve();
    expect(copy.getAttribute("aria-label")).toBe("Copy comment text");
    copy.click();
    await Promise.resolve();
    expect(write).toHaveBeenLastCalledWith("Updated content");
    expect(card.querySelectorAll(".cm-inlineCommentCopyButton")).toHaveLength(
      1,
    );
    let fail!: (error: Error) => void;
    write.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    copy.click();
    widget.destroy(card);
    card.remove();
    fail(new Error("Late failure"));
    await Promise.resolve();
    expect(showError).toHaveBeenCalledOnce();
    // jsdom queues selectionchange when the focused button is removed.
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    saving(false);
    widget.destroy(card);
    showError.mockRestore();
    vi.useRealTimers();
    if (previousClipboard)
      Object.defineProperty(navigator, "clipboard", previousClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
