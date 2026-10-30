import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemsPanel } from "./problems-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProblemsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.replaceChildren();
  });

  it("renders as a compact top toolbar matching the PDF toolbar height", () => {
    act(() => {
      root.render(
        <ProblemsPanel
          diagnostics={[
            {
              from: 5,
              to: 8,
              severity: "error",
              message: "Missing $ inserted",
              line: 3,
            },
          ]}
          fileName="main.tex"
          onNavigate={vi.fn()}
        />,
      );
    });

    const panel = container.querySelector("[data-problems-panel='true']");
    expect(panel?.className).toContain("h-12");
    expect(panel?.className).toContain("border-b");
    expect(panel?.className).not.toContain("border-t");
    expect(container.textContent).toContain("Problems");
    expect(container.textContent).toContain("Missing $ inserted");
  });
  it("filters the bar, navigation, and bulk fixes without changing the diagnostics", () => {
    const onNavigate = vi.fn();
    const onFixAllWithChat = vi.fn();
    const diagnostics = [
      { from: 5, to: 8, severity: "error", message: "First error", line: 2 },
      {
        from: 20,
        to: 25,
        severity: "warning",
        message: "First warning",
        line: 4,
      },
      {
        from: 30,
        to: 35,
        severity: "warning",
        message: "Second warning",
        line: 6,
      },
    ];
    const render = (items = diagnostics, fileName = "main.tex") =>
      act(() => {
        root.render(
          <ProblemsPanel
            diagnostics={items}
            fileName={fileName}
            onNavigate={onNavigate}
            onFixAllWithChat={onFixAllWithChat}
          />,
        );
      });
    const click = (label: string) =>
      act(() => {
        container
          .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
          .click();
      });
    render();
    expect(container.textContent).toContain("First error");
    expect(container.textContent).toContain("1/3");
    expect(container.textContent).not.toContain("Line 2");
    click("Fix with Chat");
    expect(onFixAllWithChat).toHaveBeenLastCalledWith(diagnostics);
    click("Errors");
    click("Fix with Chat");
    expect(onFixAllWithChat).toHaveBeenLastCalledWith([diagnostics[0]]);
    click("Next problem");
    expect(onNavigate).toHaveBeenLastCalledWith(5);
    click("Warnings");
    expect(
      container
        .querySelector('[aria-label="Warnings"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.textContent).toContain("First warning");
    expect(container.textContent).not.toContain("First error");
    expect(container.textContent).toContain("1/2");
    click("Next problem");
    expect(onNavigate).toHaveBeenLastCalledWith(30);
    expect(container.textContent).toContain("Second warning");
    expect(container.textContent).toContain("2/2");
    expect(
      container.querySelector('button[aria-label="Fix with chat"]'),
    ).toBeNull();
    click("Fix with Chat");
    expect(onFixAllWithChat).toHaveBeenLastCalledWith(diagnostics.slice(1));
    click("Next problem");
    expect(onNavigate).toHaveBeenLastCalledWith(20);
    click("Previous problem");
    expect(onNavigate).toHaveBeenLastCalledWith(30);
    // When one warning disappears, clamp selection within the filtered list.
    render(diagnostics.slice(0, 2));
    expect(container.textContent).toContain("First warning");
    expect(container.textContent).toContain("1/1");
    // An explicitly selected category stays selected when it becomes empty.
    render([diagnostics[0]]);
    expect(container.textContent).toContain("No warnings");
    expect(
      container.querySelector('button[aria-label="Next problem"]'),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label="Fix with Chat"]'),
    ).toBeNull();
    render(diagnostics, "other.tex");
    expect(container.textContent).toContain("First error");
    expect(diagnostics.map((d) => d.severity)).toEqual([
      "error",
      "warning",
      "warning",
    ]);
  });

  it("defaults to all when only warnings are present", () => {
    act(() =>
      root.render(
        <ProblemsPanel
          diagnostics={[
            {
              from: 0,
              to: 5,
              severity: "warning",
              message: "Only warning",
              line: 1,
            },
          ]}
          fileName="main.tex"
          onNavigate={vi.fn()}
        />,
      ),
    );
    expect(
      container
        .querySelector('[aria-label="All"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.textContent).toContain("Only warning");
    expect(container.querySelector('[aria-label="Errors"]')?.textContent).toBe(
      "0",
    );
  });
  it("shows compile problems without inventing a source location", () => {
    const onNavigate = vi.fn();
    act(() =>
      root.render(
        <ProblemsPanel
          diagnostics={[
            {
              from: null,
              to: null,
              line: null,
              severity: "error",
              message: "File custom.sty not found",
              source: "compile",
            },
          ]}
          fileName="main.tex"
          onNavigate={onNavigate}
        />,
      ),
    );
    expect(container.textContent).not.toContain("Last compile");
    expect(container.textContent).not.toContain("main.tex:null");
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Next problem"]')!
        .click(),
    );
    expect(onNavigate).not.toHaveBeenCalled();
  });
  it("selects the first matching marker without changing the filter or replaying ignored clicks", () => {
    const diagnostics = [
      { from: 1, to: 2, line: 1, severity: "error", message: "First error" },
      {
        from: 3,
        to: 4,
        line: 2,
        severity: "warning",
        message: "First warning",
      },
      {
        from: 5,
        to: 6,
        line: 3,
        severity: "warning",
        message: "Second warning",
      },
    ];
    const render = (targets: typeof diagnostics) =>
      act(() =>
        root.render(
          <ProblemsPanel
            diagnostics={diagnostics}
            fileName="main.tex"
            onNavigate={vi.fn()}
            navigationSelection={{ diagnostics: targets }}
          />,
        ),
      );
    const click = (label: string) =>
      act(() =>
        container
          .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
          .click(),
      );
    render([]);
    click("Warnings");
    render([diagnostics[0], diagnostics[2], diagnostics[1]]);
    expect(container.textContent).toContain("Second warning");
    expect(
      container
        .querySelector('[aria-label="Warnings"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    render([diagnostics[0]]);
    expect(container.textContent).toContain("Second warning");
    click("All");
    expect(container.textContent).toContain("First error");
    render([diagnostics[2], diagnostics[0]]);
    expect(container.textContent).toContain("Second warning");
    expect(container.textContent).toContain("3/3");
  });
});
