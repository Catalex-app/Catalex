import { describe, expect, it, vi } from "vitest";
import { collectFrontendHealthSnapshot } from "./frontend-health";

describe("frontend health snapshot", () => {
  it("reports missing root and loading overlay state", () => {
    document.body.innerHTML = '<div id="loading-screen">Loading</div>';
    vi.spyOn(document, "hasFocus").mockReturnValue(false);

    const snapshot = collectFrontendHealthSnapshot(document, window, 12_345);

    expect(snapshot.timestamp).toBe(12_345);
    expect(snapshot.root.exists).toBe(false);
    expect(snapshot.loadingScreen.exists).toBe(true);
    expect(snapshot.document.hasFocus).toBe(false);
    expect(snapshot.centerElement).toBeNull();
  });

  it("captures paint-relevant root, body, and center element state", () => {
    document.body.innerHTML =
      '<main id="root"><button id="target" aria-label="Run">Click</button></main>';
    const root = document.getElementById("root") as HTMLElement;
    const target = document.getElementById("target") as HTMLElement;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      toJSON: () => {},
    });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      width: 80,
      height: 32,
      top: 100,
      right: 180,
      bottom: 132,
      left: 100,
      toJSON: () => {},
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => target),
    });

    const snapshot = collectFrontendHealthSnapshot(document, window, 67_890);

    expect(snapshot.root).toMatchObject({
      exists: true,
      childElementCount: 1,
      rect: { width: 800, height: 600 },
    });
    expect(snapshot.body.childElementCount).toBe(1);
    expect(snapshot.centerElement).toMatchObject({
      tagName: "button",
      id: "target",
      ariaLabel: "Run",
      rect: { width: 80, height: 32 },
    });
  });

  it("captures chat drawer state and hit-test stacks", () => {
    document.body.innerHTML = `
      <main id="root">
        <div
          data-chat-drawer-overlay="true"
          data-assistant-mode="sidecar"
          data-drawer-presence="visible"
          data-mode-transition-phase="idle"
          data-composer-transfer-phase="idle"
        >
          <div data-chat-drawer-transition-shell="true">
            <section data-chat-drawer-panel="true">
              <div data-chat-composer-shell="true">Composer</div>
            </section>
          </div>
        </div>
        <div id="editor-line" class="cm-line">Line</div>
      </main>
    `;
    const overlay = document.querySelector(
      "[data-chat-drawer-overlay='true']",
    ) as HTMLElement;
    const panel = document.querySelector(
      "[data-chat-drawer-panel='true']",
    ) as HTMLElement;
    const composer = document.querySelector(
      "[data-chat-composer-shell='true']",
    ) as HTMLElement;
    const editorLine = document.getElementById("editor-line") as HTMLElement;

    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
      toJSON: () => {},
    });
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 500,
      width: 800,
      height: 100,
      top: 500,
      right: 800,
      bottom: 600,
      left: 0,
      toJSON: () => {},
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => editorLine),
    });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [composer, panel, overlay, editorLine]),
    });

    const snapshot = collectFrontendHealthSnapshot(document, window, 90_123);

    expect(snapshot.chat.state).toEqual({
      assistantMode: "sidecar",
      drawerPresence: "visible",
      modeTransitionPhase: "idle",
      composerTransferPhase: "idle",
    });
    expect(snapshot.chat.drawerPanel).toMatchObject({
      exists: true,
      tagName: "section",
      rect: { width: 800, height: 100 },
    });
    expect(snapshot.chat.composerShell.exists).toBe(true);
    expect(snapshot.hitTest.centerStack.map((entry) => entry.tagName)).toEqual([
      "div",
      "section",
      "div",
      "div",
    ]);
  });
});
