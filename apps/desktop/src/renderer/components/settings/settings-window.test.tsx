import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorFontSizeDropdown, SettingsWindow } from "./settings-window";
import { DEFAULT_MODE_THEMES } from "@/lib/ui-theme";
import { useSettingsStore } from "@/stores/settings-store";

vi.mock("@/lib/app-version", () => ({
  resolveAppVersion: vi.fn(async () => "0.0.0-test"),
}));

vi.mock("@/lib/markdown-theme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/markdown-theme")>()),
  resolveMarkdownThemeDirectory: vi.fn(async () => "/themes"),
  listMarkdownThemes: vi.fn(async () => []),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("EditorFontSizeDropdown", () => {
  let container: HTMLDivElement;
  let root: Root;
  let value = 14;
  let onValueChange: ReturnType<typeof vi.fn>;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  function renderDropdown() {
    act(() => {
      root.render(
        <EditorFontSizeDropdown value={value} onValueChange={onValueChange} />,
      );
    });
  }

  function clickElement(element: Element) {
    act(() => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    value = 14;
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    onValueChange = vi.fn((nextValue: number) => {
      value = nextValue;
      renderDropdown();
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.replaceChildren();
  });

  it("opens a compact option list without a search input", () => {
    renderDropdown();

    clickElement(container.querySelector("button") as HTMLButtonElement);

    const options = Array.from(
      document.body.querySelectorAll('[role="option"]'),
    );
    expect(document.body.querySelector("input")).toBeNull();
    expect(options).toHaveLength(15);
    expect(options[0]?.textContent).toBe("8px");
    expect(options[options.length - 1]?.textContent).toBe("22px");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("selects the maximum font size from the dropdown", () => {
    renderDropdown();

    clickElement(container.querySelector("button") as HTMLButtonElement);

    const maxOption = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "22px",
    );
    expect(maxOption).toBeTruthy();
    clickElement(maxOption as HTMLButtonElement);

    expect(onValueChange).toHaveBeenLastCalledWith(22);
    expect(container.textContent).toContain("22px");
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  });
});

describe("workspace theme settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    useSettingsStore.setState({ modeThemes: { ...DEFAULT_MODE_THEMES } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
    await act(async () => {
      root.render(<SettingsWindow />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("shows independent theme assignments alongside light and dark appearance", () => {
    expect(
      container.querySelector('[aria-label="Appearance"]')?.textContent,
    ).toBe("System");
    expect(
      container.querySelector('[aria-label="Artisan theme"]')?.textContent,
    ).toBe("Classic");
    expect(
      container.querySelector('[aria-label="Duet theme"]')?.textContent,
    ).toBe("Modern");
    expect(container.querySelector('[aria-label="Vibe theme"]')).toBeNull();
  });

  it("finds theme assignments by an available theme name", () => {
    const input = container.querySelector(
      'input[placeholder="Search settings"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "classic");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const navigation = container.querySelector("nav");
    expect(navigation?.textContent).toContain("Artisan Theme");
    expect(navigation?.textContent).toContain("Duet Theme");
    expect(navigation?.textContent).not.toContain("Vibe Theme");
    expect(navigation?.textContent).toContain("Classic");
  });
});
