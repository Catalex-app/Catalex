import * as endpoints from "./pdf-comment-resize";
import { getActiveComment, setActiveComment } from "../editor/active-comment";
import { preparePdfCommentLayout } from "@/lib/workspace-events";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  PdfCommentInteraction,
  PdfCommentLayer,
  type PdfCommentTarget,
} from "./pdf-comments";
import type { StructuredTextData } from "@/lib/mupdf/types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("focuses every segment, navigates only with the editor visible, and dismisses the shared popup", async () => {
  const target: PdfCommentTarget = {
    filePath: "main.tex",
    firstLine: 1,
    lastLine: 1,
    sourceText: "one two",
    sourceContent: "one two",
    sourceBefore: "",
    sourceAfter: "",
    comment: {
      id: "c",
      from: 0,
      to: 7,
      line: 1,
      text: "Review this",
      number: 1,
    },
  };
  const context = {
    targets: [target],
    navigate: vi.fn(),
    lookup: vi.fn(async () => [
      {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        sources: [{ file: "main.tex", line: 1 }],
      },
    ]),
  };
  const textData = {
    blocks: [
      {
        lines: ["one", "two"].map((text, i) => ({
          text,
          y: 10 + i * 10,
          bbox: { x: 0, y: i * 10, w: 40, h: 10 },
          font: { name: "test", size: 10 },
        })),
      },
    ],
  } as StructuredTextData;
  const actions = { onEdit: vi.fn(), onResolve: vi.fn(), onDelete: vi.fn() };
  function Harness({ editorVisible }: { editorVisible: boolean }) {
    const page = useRef<HTMLDivElement>(null);
    return (
      <PdfCommentInteraction
        context={context}
        editorVisible={editorVisible}
        actionsFor={() => actions}
      >
        <div ref={page}>
          <span data-background>Paper</span>
          <PdfCommentLayer
            textData={textData}
            pageNumber={1}
            pageWidth={100}
            pageHeight={100}
            pageElement={page}
          />
        </div>
      </PdfCommentInteraction>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const clickHighlight = async () => {
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>("[data-pdf-comment-highlight]")!
        .click(),
    );
  };
  const endpoint = vi.spyOn(endpoints, "pdfCommentEndpoint");
  try {
    await act(async () => root.render(<Harness editorVisible />));
    const initialMappings = endpoint.mock.calls.length;
    expect(initialMappings).toBeGreaterThan(0);
    await clickHighlight();
    expect(endpoint).toHaveBeenCalledTimes(initialMappings);
    expect(context.navigate).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    const boxes = host.querySelectorAll<HTMLElement>(
      '[data-testid="pdf-comment-focus-box"]',
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0].style.height).toBe("20%");
    expect(boxes[0].style.width).toBe("40%");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.render(<Harness editorVisible={false} />));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Review this",
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[role="dialog"] [aria-label="Edit comment"]',
        )!
        .click(),
    );
    expect(actions.onEdit).toHaveBeenCalledWith("c");
    const focusedButton = host.querySelector("button")!;
    await act(async () =>
      focusedButton.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    await clickHighlight();
    expect(context.navigate).toHaveBeenCalledTimes(1);
    await act(async () =>
      host.querySelector<HTMLElement>("[data-background]")!.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: 500,
          clientY: 500,
        }),
      ),
    );
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    await clickHighlight();
    let exitDelay = 0;
    await act(async () => {
      exitDelay = preparePdfCommentLayout(host, true);
    });
    expect(exitDelay).toBe(140);
    expect(host.querySelector(".pdf-comment-exit")).not.toBeNull();
    expect(host.querySelector(".pdf-comment-enter")).toBeNull();
  } finally {
    endpoint.mockRestore();
    await act(async () => root.unmount());
    host.remove();
  }
});

it.each([
  false,
  true,
])("handles a requested comment before its PDF anchor mounts (editor visible: %s)", async (editorVisible) => {
  setActiveComment(null);
  const target: PdfCommentTarget = {
    filePath: "main.tex",
    firstLine: 1,
    lastLine: 1,
    sourceText: "one",
    sourceBefore: "",
    sourceAfter: "",
    comment: { id: "late", from: 0, to: 3, line: 1, text: "Review" },
  };
  const context = {
    targets: [target],
    navigate: vi.fn(),
    lookup: vi.fn(async () => []),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const frames = vi.spyOn(window, "requestAnimationFrame");
  try {
    await act(async () =>
      root.render(
        <PdfCommentInteraction
          context={context}
          editorVisible={editorVisible}
          requestedCommentId="late"
          actionsFor={() => ({ onEdit() {}, onResolve() {}, onDelete() {} })}
        >
          <div data-anchor-host />
        </PdfCommentInteraction>,
      ),
    );
    expect(getActiveComment()).toBe(editorVisible ? "late" : null);
    if (editorVisible) expect(context.navigate).toHaveBeenCalledWith(target);
    else expect(context.navigate).not.toHaveBeenCalled();
    expect(frames).not.toHaveBeenCalled();
    const anchor = document.createElement("span");
    anchor.dataset.pdfCommentId = "late";
    await act(async () => {
      host.querySelector("[data-anchor-host]")!.append(anchor);
    });
    // PDF-only mode waits for the anchor; editor mode already navigated.
    expect(getActiveComment()).toBe("late");
    expect(context.navigate).toHaveBeenCalledTimes(editorVisible ? 1 : 0);
  } finally {
    await act(async () => root.unmount());
    setActiveComment(null);
    frames.mockRestore();
    host.remove();
  }
});
