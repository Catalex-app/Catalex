import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LatexEditorHeader } from "./latex-editor-header";
import { MarkdownEditorHeader } from "./markdown-editor-header";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

for (const Header of [LatexEditorHeader, MarkdownEditorHeader]) {
  it(`${Header.name} collapses based on remaining space and restores inline tools`, () => {
    let available = 500;
    let resize = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const measure = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return {
          width: this.hasAttribute("data-formatting-collapsed")
            ? available
            : 350,
        } as DOMRect;
      });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <Header
            wordCount={100}
            characterCount={500}
            selectedWords={0}
            selectedCharacters={0}
            onInlineFormat={vi.fn()}
            onBlockFormat={vi.fn()}
          />,
        ),
      );
      expect(
        container.querySelector('[data-formatting-collapsed="false"]'),
      ).not.toBeNull();
      available = 200;
      act(resize);
      expect(
        container.querySelector('[data-formatting-collapsed="true"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('button[aria-label="Formatting options"]'),
      ).not.toBeNull();
      expect(
        container.querySelector("[inert]")?.getAttribute("aria-hidden"),
      ).toBe("true");
      // Changing status counts can reduce space without a window resize.
      available = 351;
      act(resize);
      expect(
        container.querySelector('[data-formatting-collapsed="false"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('button[aria-label="Formatting options"]'),
      ).toBeNull();
      expect(
        container.querySelector('button[aria-label="Bold"]'),
      ).not.toBeNull();
    } finally {
      act(() => root.unmount());
      measure.mockRestore();
      vi.unstubAllGlobals();
    }
    expect(disconnect).toHaveBeenCalled();
  });
}
