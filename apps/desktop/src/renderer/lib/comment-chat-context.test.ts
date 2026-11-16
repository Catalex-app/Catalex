import { useDocumentStore } from "@/stores/document-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatChatPrompt } from "./chat-prompt";
import {
  commentChatContext,
  commentsInPdfSelection,
  commentsInSelection,
  createPdfSelectionCommentRecovery,
} from "./comment-chat-context";
import * as mupdfClient from "./mupdf/mupdf-client";
import * as pdfDocCache from "./mupdf/pdf-doc-cache";
import * as pdfPassage from "./mupdf/pdf-comment-passage";

afterEach(() => vi.restoreAllMocks());

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
    const anchor = {
      fingerprint: "a".repeat(40),
      ranges: [{ page: 1, from: 10, to: 14 }],
      source: new Uint8Array(),
    };
    store.setPdfSelectionContext(
      {
        label: "PDF · p. 1",
        filePath: "intro.pdf",
        selectedText: "text",
      },
      anchor,
    );
    expect(useDocumentStore.getState().commentSelectionContext).toBeNull();
    expect(useDocumentStore.getState().pdfSelectionAnchor).toEqual(anchor);
    store.setSelectionRange(null);
    expect(useDocumentStore.getState().pdfSelectionAnchor).toBeNull();
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

it("matches PDF comments by version, page, and overlapping characters", () => {
  const region = { page: 2, x: 20, y: 30, width: 40, height: 10 };
  const fingerprint = "a".repeat(40);
  const anchor = {
    fingerprint,
    text: "Selected PDF text",
    regions: [region],
  };
  const pdfComment = { ...comment, from: 0, to: 0, pdf: anchor };
  const otherLine = { ...anchor };
  const adjacent = { ...anchor };
  const otherPage = { ...anchor, regions: [{ ...region, page: 3 }] };
  const previousVersion = { ...anchor, fingerprint: "b".repeat(40) };
  const contexts = commentsInPdfSelection(
    "paper.pdf",
    [
      pdfComment,
      {
        ...pdfComment,
        id: "other-line",
        pdf: otherLine,
      },
      {
        ...pdfComment,
        id: "touches-edge",
        pdf: adjacent,
      },
      {
        ...pdfComment,
        id: "other-page",
        pdf: otherPage,
      },
      {
        ...pdfComment,
        id: "previous-version",
        pdf: previousVersion,
      },
      { ...pdfComment, id: "resolved", resolved: true },
      { ...pdfComment, id: "draft", text: "" },
      { ...pdfComment, id: "unrecoverable", pdf: { ...anchor } },
      comment,
    ],
    {
      fingerprint,
      ranges: [{ page: 2, from: 30, to: 34 }],
      source: new Uint8Array(),
    },
    new Map([
      [anchor, [{ page: 2, from: 20, to: 37 }]],
      [otherLine, [{ page: 2, from: 4, to: 25 }]],
      [adjacent, [{ page: 2, from: 12, to: 30 }]],
      [otherPage, [{ page: 3, from: 20, to: 37 }]],
      [previousVersion, [{ page: 2, from: 20, to: 37 }]],
    ]),
  );
  expect(contexts).toEqual([commentChatContext("paper.pdf", pdfComment)]);
});

it("skips distant uncached highlights and compares recovered text for nearby highlights", async () => {
  const getPageText = vi.fn().mockResolvedValue({
    blocks: [{ lines: [{ text: "alpha beta gamma" }] }],
  });
  vi.spyOn(mupdfClient, "getMupdfClient").mockReturnValue({
    getPageText,
  } as unknown as ReturnType<typeof mupdfClient.getMupdfClient>);
  vi.spyOn(pdfDocCache, "getOrOpenDocument").mockResolvedValue({
    docId: 1,
    pageSizes: [],
    cacheHit: true,
  });
  const fingerprint = "a".repeat(40);
  const region = { page: 1, x: 20, y: 30, width: 40, height: 10 };
  const selected = {
    fingerprint,
    source: new Uint8Array(),
    ranges: [{ page: 1, from: 6, to: 10 }],
    regions: [region],
  };
  const matching = { fingerprint, text: "beta", regions: [region] };
  const touching = { fingerprint, text: "alpha", regions: [region] };
  const nearEdge = {
    fingerprint,
    text: "beta",
    regions: [{ ...region, x: region.x + region.width + 2 }],
  };
  const distant = Array.from({ length: 25 }, (_, index) => ({
    fingerprint,
    text: "gamma",
    regions: [{ ...region, y: 200 + index * 10 }],
  }));
  const comments = [matching, touching, nearEdge, ...distant].map((pdf, i) => ({
    ...comment,
    id: String(i),
    pdf,
  }));
  const recovery = createPdfSelectionCommentRecovery();
  const recovered = await recovery.recover(comments, selected);
  expect([...recovered.keys()]).toEqual([matching, touching, nearEdge]);
  expect(
    commentsInPdfSelection("paper.pdf", comments, selected, recovered).map(
      ({ comment }) => comment?.id,
    ),
  ).toEqual(["0", "2"]);
  expect(getPageText).toHaveBeenCalledTimes(1);

  const cached = await recovery.recover(comments, {
    ...selected,
    regions: [{ ...region, x: 300 }],
  });
  expect(cached.get(matching)).toEqual(recovered.get(matching));
  expect(getPageText).toHaveBeenCalledTimes(1);

  const missingBounds = await recovery.recover(comments, {
    ...selected,
    regions: [{ ...region, page: 2 }],
  });
  expect(missingBounds.get(distant[0])).toEqual([
    { page: 1, from: 11, to: 16 },
  ]);
});

function pdfRecoveryFixture() {
  const pageText = {
    blocks: [{ lines: [{ text: "alpha beta gamma" }] }],
  };
  const getPageText = vi.fn().mockResolvedValue(pageText);
  vi.spyOn(mupdfClient, "getMupdfClient").mockReturnValue({
    getPageText,
  } as unknown as ReturnType<typeof mupdfClient.getMupdfClient>);
  vi.spyOn(pdfDocCache, "getOrOpenDocument").mockResolvedValue({
    docId: 1,
    pageSizes: [],
    cacheHit: true,
  });
  const region = { page: 1, x: 20, y: 30, width: 40, height: 10 };
  const pdf = { fingerprint: "a".repeat(40), text: "beta", regions: [region] };
  const comments = [{ ...comment, pdf }];
  const selection = {
    fingerprint: pdf.fingerprint,
    source: new Uint8Array(),
    ranges: [{ page: 1, from: 6, to: 10 }],
    regions: [region],
  };
  return {
    pageText,
    getPageText,
    pdf,
    comments,
    selection,
    distantSelection: { ...selection, regions: [{ ...region, x: 300 }] },
  };
}

describe("PDF comment recovery lifetime", () => {
  it.each([
    "deleted",
    "resolved",
    "replaced",
  ])("releases %s anchors while another selection remains active", async (change) => {
    const { comments, pdf, selection, distantSelection, getPageText } =
      pdfRecoveryFixture();
    const recovery = createPdfSelectionCommentRecovery();
    await recovery.recover(comments, selection);
    const updated =
      change === "deleted"
        ? []
        : comments.map((item) =>
            change === "resolved"
              ? { ...item, resolved: true }
              : { ...item, pdf: { ...pdf, text: "gamma" } },
          );
    await recovery.recover(updated, distantSelection);
    const restored = await recovery.recover(comments, distantSelection);
    expect(restored.size).toBe(0);
    expect(getPageText).toHaveBeenCalledTimes(1);
    expect((await recovery.recover(comments, selection)).get(pdf)).toEqual([
      { page: 1, from: 6, to: 10 },
    ]);
    expect(getPageText).toHaveBeenCalledTimes(2);
  });

  it("releases cached anchors on dismissal and source changes", async () => {
    const { comments, pdf, selection, distantSelection, getPageText } =
      pdfRecoveryFixture();
    const recovery = createPdfSelectionCommentRecovery();
    await recovery.recover(comments, selection);
    recovery.clear();
    expect((await recovery.recover(comments, distantSelection)).size).toBe(0);
    await recovery.recover(comments, selection);
    expect(getPageText).toHaveBeenCalledTimes(2);
    await recovery.recover(comments, {
      ...distantSelection,
      source: new Uint8Array(),
    });
    expect((await recovery.recover(comments, distantSelection)).size).toBe(0);
    expect((await recovery.recover(comments, selection)).has(pdf)).toBe(true);
    expect(getPageText).toHaveBeenCalledTimes(3);
  });

  it.each([
    "dismissed",
    "deleted",
  ])("discards pending recovery after its selection is %s", async (change) => {
    const { comments, selection, distantSelection, getPageText, pageText } =
      pdfRecoveryFixture();
    let finishRead!: (value: typeof pageText) => void;
    getPageText.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const recovery = createPdfSelectionCommentRecovery();
    const recoverRanges = vi.spyOn(pdfPassage, "recoverPdfCommentRanges");
    const pending = recovery.recover(comments, selection);
    await vi.waitFor(() => expect(getPageText).toHaveBeenCalledTimes(1));
    if (change === "dismissed") recovery.clear();
    else await recovery.recover([], selection);
    finishRead(pageText);
    expect((await pending).size).toBe(0);
    expect(recoverRanges).not.toHaveBeenCalled();
    expect((await recovery.recover(comments, distantSelection)).size).toBe(0);
    await recovery.recover(comments, selection);
    expect(getPageText).toHaveBeenCalledTimes(2);
  });

  it("stops dismissed recovery before requesting worker text", async () => {
    const { comments, selection, getPageText } = pdfRecoveryFixture();
    let finishOpen!: () => void;
    vi.mocked(pdfDocCache.getOrOpenDocument).mockReturnValueOnce(
      new Promise((resolve) => {
        finishOpen = () => resolve({ docId: 1, pageSizes: [], cacheHit: true });
      }),
    );
    const recovery = createPdfSelectionCommentRecovery();
    const pending = recovery.recover(comments, selection);
    recovery.clear();
    finishOpen();
    expect((await pending).size).toBe(0);
    expect(getPageText).not.toHaveBeenCalled();
  });

  it("preserves a new request for the same anchor when a dismissed request finishes", async () => {
    const { comments, pdf, selection, getPageText, pageText } =
      pdfRecoveryFixture();
    let finishOld!: (value: typeof pageText) => void;
    let finishCurrent!: (value: typeof pageText) => void;
    getPageText
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishCurrent = resolve;
        }),
      );
    const recovery = createPdfSelectionCommentRecovery();
    const recoverRanges = vi.spyOn(pdfPassage, "recoverPdfCommentRanges");
    const old = recovery.recover(comments, selection);
    await vi.waitFor(() => expect(getPageText).toHaveBeenCalledTimes(1));
    recovery.clear();
    const current = recovery.recover(comments, selection);
    await vi.waitFor(() => expect(getPageText).toHaveBeenCalledTimes(2));
    finishOld(pageText);
    expect((await old).size).toBe(0);
    expect(recoverRanges).not.toHaveBeenCalled();
    finishCurrent(pageText);
    expect((await current).get(pdf)).toEqual([{ page: 1, from: 6, to: 10 }]);
    expect(recoverRanges).toHaveBeenCalledTimes(1);
    await recovery.recover(comments, selection);
    expect(getPageText).toHaveBeenCalledTimes(2);
  });

  it("removes an already recovered anchor while another page is still pending", async () => {
    const { comments, pdf, selection, getPageText, pageText } =
      pdfRecoveryFixture();
    const second = {
      ...pdf,
      regions: pdf.regions.map((region) => ({ ...region, page: 2 })),
    };
    const secondComment = { ...comments[0], id: "second", pdf: second };
    const bothPages = {
      ...selection,
      ranges: [...selection.ranges, { ...selection.ranges[0], page: 2 }],
      regions: [...selection.regions, ...second.regions],
    };
    let finishSecond!: (value: typeof pageText) => void;
    getPageText.mockResolvedValueOnce(pageText).mockReturnValueOnce(
      new Promise((resolve) => {
        finishSecond = resolve;
      }),
    );
    const recovery = createPdfSelectionCommentRecovery();
    const recoverRanges = vi.spyOn(pdfPassage, "recoverPdfCommentRanges");
    const old = recovery.recover([...comments, secondComment], bothPages);
    await vi.waitFor(() => expect(recoverRanges).toHaveBeenCalledTimes(1));
    const current = recovery.recover([secondComment], bothPages);
    finishSecond(pageText);
    expect([...(await old).keys()]).toEqual([second]);
    expect([...(await current).keys()]).toEqual([second]);
    expect(getPageText).toHaveBeenCalledTimes(2);
  });

  it("keeps recovery owners independent when one composer dismisses selection", async () => {
    const { comments, pdf, selection, distantSelection, getPageText } =
      pdfRecoveryFixture();
    const first = createPdfSelectionCommentRecovery();
    const second = createPdfSelectionCommentRecovery();
    await first.recover(comments, selection);
    await second.recover(comments, selection);
    expect(getPageText).toHaveBeenCalledTimes(2);
    first.clear();
    expect((await first.recover(comments, distantSelection)).size).toBe(0);
    expect((await second.recover(comments, distantSelection)).has(pdf)).toBe(
      true,
    );
    expect(getPageText).toHaveBeenCalledTimes(2);
  });
});
