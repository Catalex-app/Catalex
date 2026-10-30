import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  CommentsPanel,
  CommentsSummaryButton,
  type CommentFilter,
} from "./comments-panel";
import type { InlineEditorComment } from "./inline-comments";
import { setActiveComment } from "./active-comment";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("counts authors, filters, wraps navigation and handles removal without mutating comments", () => {
  const comments: InlineEditorComment[] = [
    { id: "h", number: 12, from: 30, to: 35, line: 3, text: "Human" },
    {
      id: "a",
      number: 7,
      from: 0,
      to: 5,
      line: 1,
      text: "Agent",
      origin: { provider: "codex", sessionId: "s" },
    },
  ];
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  function Harness({ items = comments }: { items?: InlineEditorComment[] }) {
    const [filter, setFilter] = useState<CommentFilter>("all");
    return (
      <>
        <CommentsSummaryButton comments={items} onOpen={vi.fn()} />
        <CommentsPanel
          comments={items}
          filter={filter}
          onFilter={setFilter}
          onClose={onClose}
          onNavigate={onNavigate}
        />
      </>
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const click = (label: string) =>
    act(() =>
      container
        .querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
        .click(),
    );
  try {
    act(() => root.render(<Harness />));
    expect(
      container.querySelector('[aria-label="Show comments: 1 human, 1 agent"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Go to comment A-7"]'),
    ).not.toBeNull();
    click("Next comment");
    expect(onNavigate).toHaveBeenLastCalledWith(comments[0]);
    click("Next comment");
    expect(onNavigate).toHaveBeenLastCalledWith(comments[1]);
    click("Previous comment");
    expect(onNavigate).toHaveBeenLastCalledWith(comments[0]);
    click("Human comments");
    expect(
      container.querySelector('[aria-label="Comment 1 of 1"]'),
    ).not.toBeNull();
    click("Go to comment H-12");
    expect(onNavigate).toHaveBeenLastCalledWith(comments[0]);
    act(() => root.render(<Harness items={[comments[1]]} />));
    expect(container.textContent).toContain("No comments");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Next comment"]')
        ?.disabled,
    ).toBe(true);
    click("Agent comments");
    expect(
      container.querySelector('[aria-label="Go to comment A-7"]'),
    ).not.toBeNull();
    click("Hide comments");
    expect(onClose).toHaveBeenCalledOnce();
    expect(comments.map((comment) => comment.id)).toEqual(["h", "a"]);
    expect(container.textContent).not.toContain("Fix");
  } finally {
    act(() => root.unmount());
  }
});

it("follows shared focus while preserving navigation, filters and the last selection", () => {
  const comments: InlineEditorComment[] = [
    { id: "h", number: 1, from: 0, to: 5, line: 1, text: "Human" },
    {
      id: "a",
      number: 2,
      from: 30,
      to: 35,
      line: 3,
      text: "Agent",
      origin: { provider: "codex", sessionId: "s" },
    },
  ];
  const onNavigate = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (filter: CommentFilter = "all") =>
    act(() =>
      root.render(
        <CommentsPanel
          comments={[...comments]}
          filter={filter}
          onFilter={vi.fn()}
          onClose={vi.fn()}
          onNavigate={onNavigate}
        />,
      ),
    );
  const expectCurrent = (label: string) =>
    expect(
      container.querySelector(`[aria-label="Go to comment ${label}"]`),
    ).not.toBeNull();
  try {
    setActiveComment(null);
    render();
    expectCurrent("H-1");
    act(() => setActiveComment("a"));
    expectCurrent("A-2");
    expect(onNavigate).not.toHaveBeenCalled();
    act(() => setActiveComment(null));
    expectCurrent("A-2");
    act(() => setActiveComment("another-file"));
    expectCurrent("A-2");
    render("human");
    act(() => setActiveComment("a"));
    expectCurrent("H-1");
    render();
    expectCurrent("A-2");
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Next comment"]')!
        .click();
    });
    expectCurrent("H-1");
    expect(onNavigate).toHaveBeenLastCalledWith(comments[0]);
    // A fresh comments array must not restore stale focus while navigation is pending.
    render();
    expectCurrent("H-1");
    act(() => setActiveComment("h"));
    expectCurrent("H-1");
  } finally {
    act(() => root.unmount());
    setActiveComment(null);
  }
});
