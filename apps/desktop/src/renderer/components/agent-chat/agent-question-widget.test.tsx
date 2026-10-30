import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskUserQuestionWidget } from "./tool-widgets";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/stores/agent-chat-store", () => ({
  useAgentChatStore: Object.assign(
    (selector: (state: { isStreaming: boolean }) => unknown) =>
      selector({ isStreaming: true }),
    { getState: () => ({ isStreaming: true, sendPrompt: vi.fn() }) },
  ),
}));

describe("MCP question widget", () => {
  let container: HTMLDivElement;
  let root: Root;
  const input = {
    questions: [
      {
        question: "What should happen to unsaved comments?",
        options: [
          { label: "Update comments" },
          { label: "Discard unsaved comments" },
        ],
      },
    ],
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("focuses the first choice after the panel becomes visible", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    await act(async () =>
      root.render(<AskUserQuestionWidget input={input} onAnswer={vi.fn()} />),
    );
    const first = container.querySelector<HTMLButtonElement>(
      "[data-question-option]",
    )!;
    first.checkVisibility = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    await act(async () => frames.shift()?.(performance.now()));
    expect(document.activeElement).not.toBe(first);
    await act(async () => frames.shift()?.(performance.now() + 16));
    expect(document.activeElement).toBe(first);
  });

  it("answers the waiting MCP call while streaming without starting a new turn", async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(<AskUserQuestionWidget input={input} onAnswer={onAnswer} />),
    );
    const button = container.querySelectorAll<HTMLButtonElement>(
      "[data-question-option]",
    )[1];
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(
      "Discard unsaved comments",
    );
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("Answer sent");
  });

  it("navigates regular choices with arrows without answering or entering the custom field", async () => {
    const onAnswer = vi.fn();
    await act(async () =>
      root.render(<AskUserQuestionWidget input={input} onAnswer={onAnswer} />),
    );
    const options = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-question-option]"),
    );
    for (const option of options) option.scrollIntoView = vi.fn();
    options[0].focus();
    const press = (key: string) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    press("ArrowDown");
    expect(document.activeElement).toBe(options[1]);
    press("ArrowDown");
    expect(document.activeElement).toBe(options[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(options[1]);
    const custom = container.querySelector<HTMLInputElement>("input")!;
    custom.focus();
    press("ArrowUp");
    expect(document.activeElement).toBe(custom);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("restores the last choice when custom input loses focus without stealing deliberate focus", async () => {
    await act(async () =>
      root.render(<AskUserQuestionWidget input={input} onAnswer={vi.fn()} />),
    );
    const last = container.querySelectorAll<HTMLButtonElement>(
      "[data-question-option]",
    )[1];
    const custom = container.querySelector<HTMLInputElement>("input")!;
    last.focus();
    custom.focus();
    await act(async () => custom.blur());
    expect(document.activeElement).toBe(last);
    custom.focus();
    const first = container.querySelector<HTMLButtonElement>(
      "[data-question-option]",
    )!;
    await act(async () => first.focus());
    expect(document.activeElement).toBe(first);
  });

  it("moves keyboard focus to the hovered choice without submitting", async () => {
    const onAnswer = vi.fn();
    await act(async () =>
      root.render(<AskUserQuestionWidget input={input} onAnswer={onAnswer} />),
    );
    const options = container.querySelectorAll<HTMLButtonElement>(
      "[data-question-option]",
    );
    options[0].focus();
    await act(async () =>
      options[1].parentElement!.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      ),
    );
    expect(document.activeElement).toBe(options[1]);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("skips the question through the answer handler without choosing an option", async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(<AskUserQuestionWidget input={input} onAnswer={onAnswer} />),
    );
    const skip = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Skip",
    )!;
    expect(skip.type).toBe("button");
    expect(skip.closest("form")).toBeNull();
    expect(
      container
        .querySelector('[data-testid="agent-question-options"]')
        ?.previousElementSibling?.contains(skip),
    ).toBe(true);
    await act(async () => skip.click());
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(
      "Skip this question (no option selected).",
    );
    expect(container.querySelector("form")).toBeNull();
  });

  it("shows submission failures and keeps choices and a custom answer available", async () => {
    const onAnswer = vi.fn().mockRejectedValue(new Error("Connection failed"));
    await act(async () =>
      root.render(<AskUserQuestionWidget input={input} onAnswer={onAnswer} />),
    );
    const button = container.querySelector<HTMLButtonElement>(
      "[data-question-option]",
    )!;
    await act(async () => button.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Connection failed",
    );
    expect(button.disabled).toBe(false);
    expect(
      container.querySelector('input[aria-label="Custom answer"]'),
    ).not.toBeNull();
  });

  it("keeps the question and custom answer outside the scrollable options", async () => {
    await act(async () =>
      root.render(<AskUserQuestionWidget input={input} onAnswer={vi.fn()} />),
    );
    const scrollArea = container.querySelector(
      '[data-testid="agent-question-options"]',
    );
    expect(scrollArea).not.toBeNull();
    expect(scrollArea?.textContent).toContain("Discard unsaved comments");
    expect(scrollArea?.textContent).not.toContain(
      "What should happen to unsaved comments?",
    );
    expect(
      scrollArea?.contains(
        container.querySelector('input[aria-label="Custom answer"]'),
      ),
    ).toBe(false);
  });

  it("uses compact numbered rows and help controls without the blue card header", async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <AskUserQuestionWidget
          input={{
            questions: [
              {
                question: "What next?",
                options: [
                  {
                    label: "Discard unsaved",
                    description: "Already-saved comments stay.",
                  },
                ],
              },
            ],
          }}
          onAnswer={onAnswer}
        />,
      ),
    );
    const widget = container.querySelector(
      '[data-testid="agent-question-widget"]',
    )!;
    expect(widget.className).not.toContain("bg-blue");
    expect(widget.textContent).not.toContain("Choose an option");
    const numberBadge = widget.querySelector(
      '[data-question-option] > span[aria-hidden="true"]',
    )!;
    expect(numberBadge.textContent).toBe("1");
    expect(numberBadge.className).toContain("rounded-full");
    expect(numberBadge.className).toContain("size-4");
    expect(widget.querySelector("form label > span")).toBeNull();
    expect(widget.textContent).not.toContain("Continue");
    expect(
      widget.querySelector('[aria-label="Send custom answer"]'),
    ).not.toBeNull();
    expect(container.querySelector("button button")).toBeNull();
    const help = container.querySelector<HTMLButtonElement>(
      '[aria-label="About Discard unsaved"]',
    )!;
    await act(async () => help.click());
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
