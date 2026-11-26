import { expect, test } from "@playwright/test";
import type { BrowserHarness } from "../src/renderer/lib/desktop/bridge";

test.beforeEach(async ({ context }) => {
  // The browser harness loads the renderer as individual development modules.
  await context.addInitScript(() =>
    performance.setResourceTimingBufferSize(4096),
  );
});

test("chat titlebar names the conversation and panel header shows the last communicating provider", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
    "data-chat-layout",
    "workspace",
  );
  const title = page.locator(
    "[data-workspace-titlebar] [data-workspace-chat-title]",
  );
  await expect(title).toHaveText("Review manuscript comments");

  const label = page.locator(
    "[data-chat-title-current] [data-chat-last-provider]",
  );
  await expect(label).toHaveText("Codex");
  await expect(
    page.locator("[data-workspace-chat-pane] [data-chat-model-divider]"),
  ).toHaveText(["Codex · GPT-6.1-Sol · High"]);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    store.setState((state: any) => ({
      selectedProvider: "claude",
      tabs: state.tabs.map((tab: any) =>
        tab.id === state.activeTabId ? { ...tab, provider: "claude" } : tab,
      ),
    }));
  });
  await expect(label).toHaveText("Codex");
  await expect(
    page.locator("[data-workspace-chat-pane] [data-chat-model-divider]"),
  ).toHaveText(["Codex · GPT-6.1-Sol · High"]);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    const state = store.getState();
    state._appendMessage(state.activeTabId, {
      type: "user",
      provider: "claude",
      model: "claude-sonnet-4-6",
      reasoningEffort: "high",
      message: { content: [{ type: "text", text: "Continue with Claude" }] },
    });
  });
  await expect(label).toHaveText("Claude");
  await expect(
    page.locator("[data-workspace-chat-pane] [data-chat-model-divider]"),
  ).toHaveText(["Codex · GPT-6.1-Sol · High", "Claude · Sonnet 4.6 · High"]);
  await expect(
    page.locator("[data-chat-title-current] [data-chat-last-model]"),
  ).toHaveText("Sonnet 4.6 · High");
  await page.screenshot({ path: test.info().outputPath("provider-light.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: test.info().outputPath("provider-dark.png") });
  await page.setViewportSize({ width: 900, height: 750 });
  await expect(label).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("provider-narrow.png"),
  });
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    store.setState((state: any) => {
      const tab = {
        ...state.tabs[0],
        id: "pi-chat",
        title: "Review with Pi",
        provider: "pi",
        messages: [
          {
            type: "assistant",
            provider: "pi",
            message: { content: [{ type: "text", text: "Pi answer" }] },
          },
        ],
      };
      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        messages: tab.messages,
        selectedProvider: "pi",
      };
    });
  });
  await expect(label).toHaveText("Pi");
  await expect(title).toHaveText("Review with Pi");
  await expect(
    page.locator("[data-chat-title-current] [data-chat-last-model]"),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    store.getState().setActiveTab("demo-review");
  });
  await expect(label).toHaveText("Claude");
  await expect(title).toHaveText("Review manuscript comments");
});

test("chat header crossfades settings without moving or animating streamed replies", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
    "data-chat-layout",
    "workspace",
  );
  await expect(
    page.locator("[data-workspace-chat-pane] [data-chat-composer-shell]"),
  ).toHaveAttribute("data-composer-transfer-phase", "idle");
  const header = page.locator("[data-chat-panel-title]");
  const before = await header.boundingBox();
  const animation = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    store.getState()._appendMessage(store.getState().activeTabId, {
      type: "user",
      provider: "claude",
      model: "claude-sonnet-4-6",
      reasoningEffort: "low",
      message: { content: [{ type: "text", text: "Try a different model" }] },
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const current = document.querySelector<HTMLElement>(
      "[data-chat-title-current]",
    )!;
    const outgoing = document.querySelector<HTMLElement>(
      "[data-chat-title-outgoing]",
    )!;
    const animations = [
      ...current.getAnimations(),
      ...outgoing.getAnimations(),
    ];
    const running = animations.every((item) => item.playState === "running");
    for (const item of animations) {
      item.pause();
      item.currentTime = 60;
    }
    return {
      running,
      count: animations.length,
      current: Number(getComputedStyle(current).opacity),
      outgoing: Number(getComputedStyle(outgoing).opacity),
    };
  });
  expect(animation.running).toBe(true);
  expect(animation.count).toBe(2);
  expect(animation.current).toBeGreaterThan(0);
  expect(animation.current).toBeLessThan(1);
  expect(animation.current + animation.outgoing).toBeCloseTo(1, 2);
  expect(await header.boundingBox()).toEqual(before);
  await page
    .locator("[data-workspace-chat-pane] [data-workspace-panel-header]")
    .screenshot({ path: test.info().outputPath("header-crossfade.png") });
  await page.evaluate(() => {
    for (const element of document.querySelectorAll(
      "[data-chat-title-current], [data-chat-title-outgoing]",
    ))
      for (const animation of element.getAnimations()) animation.play();
  });
  await expect(page.locator("[data-chat-title-outgoing]")).toHaveCount(0);
  await expect(page.locator("[data-chat-title-current]")).toHaveText(
    "ClaudeSonnet 4.6 · Low",
  );
  const quiet = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    store.getState()._appendMessage(store.getState().activeTabId, {
      type: "assistant",
      provider: "claude",
      message: { content: [{ type: "text", text: "A streamed reply" }] },
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return document.querySelector("[data-chat-title-current]")!.getAnimations()
      .length;
  });
  expect(quiet).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    store.getState()._appendMessage(store.getState().activeTabId, {
      type: "user",
      provider: "claude",
      model: "claude-sonnet-4-6",
      reasoningEffort: "high",
      message: { content: [{ type: "text", text: "More effort" }] },
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return document.querySelector("[data-chat-title-current]")!.getAnimations()
      .length;
  });
  expect(reduced).toBe(0);
  await expect(page.locator("[data-chat-title-outgoing]")).toHaveCount(0);
  await expect(page.locator("[data-chat-title-current]")).toHaveText(
    "ClaudeSonnet 4.6 · High",
  );
  // The blank portion of the row still supports the panel gesture.
  await header.dblclick();
  await expect(
    page.getByRole("dialog", { name: "Chat expanded", exact: true }),
  ).toBeVisible();
});

test("chat pop-out keeps the workspace header below a separate conversation titlebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(
    page.locator("[data-workspace-chat-pane] [data-chat-composer-shell]"),
  ).toHaveAttribute("data-composer-transfer-phase", "idle");
  const opened = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "More Chat view actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Pop out Chat", exact: true })
    .click();
  const chat = await opened;
  await chat.setViewportSize({ width: 960, height: 720 });
  await expect(chat.locator("[data-panel-window-title]")).toHaveText(
    "Review manuscript comments",
  );
  await expect(chat.locator("[data-chat-title-current]")).toHaveText(
    "CodexGPT-6.1-Sol · High",
  );
  await expect(
    chat.getByRole("button", { name: "Session history", exact: true }),
  ).toHaveCount(0);
  await expect(chat.locator("[data-chat-tab-strip]")).toHaveCount(0);
  await expect(
    chat.getByRole("button", { name: "Full", exact: true }),
  ).toHaveCount(0);
  const ownerHeader = page.locator(
    "[data-workspace-chat-pane] [data-workspace-panel-header]",
  );
  const childHeader = chat.locator("[data-workspace-panel-header]");
  expect((await childHeader.boundingBox())!.height).toBe(
    (await ownerHeader.boundingBox())!.height,
  );
  const actions = chat.getByRole("button", {
    name: "More Chat view actions",
    exact: true,
  });
  await expect(actions).toBeDisabled();
  await actions.hover();
  await expect(chat.getByRole("tooltip")).toHaveText("No actions available");
  // Use an actual pointer click: locator.click intentionally refuses disabled
  // buttons, but the menu trigger must also ignore their pointer-down events.
  const actionsBox = (await actions.boundingBox())!;
  await chat.mouse.click(
    actionsBox.x + actionsBox.width / 2,
    actionsBox.y + actionsBox.height / 2,
  );
  await expect(actions).toHaveAttribute("aria-expanded", "false");
  await expect(chat.getByRole("menu")).toHaveCount(0);
  await childHeader.locator("[data-panel-header-space]").dblclick();
  await expect(chat.locator("[data-expanded-workspace-panel]")).toHaveCount(0);
  await chat.screenshot({
    path: test.info().outputPath("chat-popout-disabled-actions.png"),
  });
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    store.setState((state: any) => ({
      tabs: state.tabs.map((tab: any) =>
        tab.id === state.activeTabId
          ? { ...tab, title: "Updated conversation" }
          : tab,
      ),
    }));
    store.getState()._appendMessage(store.getState().activeTabId, {
      type: "user",
      provider: "claude",
      model: "claude-sonnet-4-6",
      reasoningEffort: "high",
      message: {
        content: [{ type: "text", text: "Continue in this model" }],
      },
    });
  });
  await expect(chat.locator("[data-panel-window-title]")).toHaveText(
    "Updated conversation",
  );
  await expect(chat).toHaveTitle("Updated conversation");
  await expect(chat.locator("[data-chat-title-current]")).toHaveText(
    "ClaudeSonnet 4.6 · High",
  );
  await expect(page.locator("[data-chat-title-current]")).toHaveText(
    "ClaudeSonnet 4.6 · High",
  );
  await chat
    .locator("[data-chat-composer-input]:visible")
    .fill("Shared pop-out draft");
  await expect(
    page
      .locator("[data-workspace-chat-pane]")
      .locator("[data-chat-composer-input]:visible"),
  ).toHaveValue("Shared pop-out draft");
  await page
    .locator("[data-workspace-chat-pane]")
    .locator("[data-chat-composer-input]:visible")
    .fill("Updated from the main window");
  await expect(chat.locator("[data-chat-composer-input]:visible")).toHaveValue(
    "Updated from the main window",
  );
  await chat.locator("[data-chat-composer-input]:visible").fill("");
  await expect(
    page
      .locator("[data-workspace-chat-pane]")
      .locator("[data-chat-composer-input]:visible"),
  ).toHaveValue("");
  await chat.screenshot({
    path: test.info().outputPath("chat-workspace-popout.png"),
  });
  await chat.close();
});

test("empty chat header reflects existing readiness in the workspace and pop-out", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await expect(
    page.getByRole("button", { name: "Toggle drawer", exact: true }),
  ).toHaveCSS("pointer-events", "none");
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(
    page.locator("[data-workspace-chat-pane] [data-chat-composer-shell]"),
  ).toHaveAttribute("data-composer-transfer-phase", "idle");
  await page.evaluate(async () => {
    const moduleUrl = (name: string) =>
      performance
        .getEntriesByType("resource")
        .find(
          (entry) =>
            new URL(entry.name).pathname === `/src/renderer/stores/${name}.ts`,
        )!.name;
    const { useAgentChatStore: store } = await import(
      /* @vite-ignore */ moduleUrl("agent-chat-store")
    );
    const { useCodexSetupStore: setup } = await import(
      /* @vite-ignore */ moduleUrl("codex-setup-store")
    );
    setup.setState({ status: "ready" });
    store.setState((s: any) => ({
      selectedProvider: "codex",
      messages: [],
      tabs: s.tabs.map((tab: any) =>
        tab.id === s.activeTabId
          ? {
              ...tab,
              title: "New Chat",
              messages: [],
              history: undefined,
              lastCommunication: undefined,
              lastCommunicationProvider: undefined,
            }
          : tab,
      ),
    }));
  });
  const readiness = page.locator(
    "[data-chat-title-current] [data-chat-readiness]",
  );
  await expect(readiness).toHaveText("Ready");
  await expect(readiness.locator("button, a, [role=button]")).toHaveCount(0);
  const opened = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "More Chat view actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Pop out Chat", exact: true })
    .click();
  const chat = await opened;
  const childReadiness = chat.locator(
    "[data-chat-title-current] [data-chat-readiness]",
  );
  await expect(childReadiness).toHaveText("Ready");
  for (const [status, label] of [
    ["not-authenticated", "Sign-in required"],
    ["checking", "Checking agent…"],
    ["not-installed", "Setup required"],
    ["error", "Agent unavailable"],
    ["ready", "Ready"],
  ]) {
    await page.evaluate(async (status) => {
      const url = performance
        .getEntriesByType("resource")
        .find(
          (entry) =>
            new URL(entry.name).pathname ===
            "/src/renderer/stores/codex-setup-store.ts",
        )!.name;
      const { useCodexSetupStore } = await import(/* @vite-ignore */ url);
      useCodexSetupStore.setState({ status });
    }, status);
    await expect(readiness).toHaveText(label);
    await expect(childReadiness).toHaveText(label);
  }
  await chat.screenshot({
    path: test.info().outputPath("new-chat-ready.png"),
    animations: "disabled",
  });
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    const s = store.getState();
    s._appendMessage(s.activeTabId, {
      type: "user",
      provider: "codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      message: { content: [{ type: "text", text: "First message" }] },
    });
  });
  await expect(page.locator("[data-chat-title-current]")).toHaveText(
    "CodexGPT-6.1-Sol · High",
  );
  await expect(chat.locator("[data-chat-title-current]")).toHaveText(
    "CodexGPT-6.1-Sol · High",
  );
  await expect(readiness).toHaveCount(0);
  await chat.close();
});

test("demo previews each passive chat status with a trailing colored dot", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf&chat-status=ready");
  const current = page.locator(
    "[data-chat-title-current] [data-chat-readiness]",
  );
  const selector = page.getByRole("combobox", { name: "Preview chat status" });
  for (const [status, label, color] of [
    ["ready", "Ready", "emerald"],
    ["checking", "Checking agent…", "amber"],
    ["not-installed", "Setup required", "amber"],
    ["not-authenticated", "Sign-in required", "amber"],
    ["error", "Agent unavailable", "red"],
  ]) {
    await selector.selectOption(status);
    await expect(current).toHaveText(label);
    const dot = current.locator("[data-chat-readiness-dot]");
    await expect(dot).toHaveClass(new RegExp(`bg-${color}-500`));
    const text = await current.locator("span").first().boundingBox();
    const dotBox = await dot.boundingBox();
    expect(dotBox!.x).toBeGreaterThan(text!.x + text!.width);
    await page
      .locator("[data-workspace-chat-pane] [data-workspace-panel-header]")
      .screenshot({
        path: test.info().outputPath(`chat-status-${status}.png`),
        animations: "disabled",
      });
  }
  await page.screenshot({
    path: test.info().outputPath("chat-status-demo.png"),
    animations: "disabled",
  });
});

test("each chat pop-out remains pinned while the owner changes chats", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await expect(
    page.getByRole("button", { name: "Toggle drawer", exact: true }),
  ).toHaveCSS("pointer-events", "none");
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(
    page.locator("[data-workspace-chat-pane] [data-chat-composer-shell]"),
  ).toHaveAttribute("data-composer-transfer-phase", "idle");
  const openChat = async () => {
    const opened = page.waitForEvent("popup");
    await page
      .getByRole("button", { name: "More Chat view actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Pop out Chat", exact: true })
      .click();
    return opened;
  };
  const first = await openChat();
  await expect(first.locator("[data-panel-window-title]")).toHaveText(
    "Review manuscript comments",
  );
  await first.locator("[data-chat-composer-input]:visible").fill("First draft");
  const ids = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    const first = store.getState().activeTabId;
    const second = store.getState().createTab();
    store.setState((s: any) => ({
      tabs: s.tabs.map((tab: any) =>
        tab.id === second ? { ...tab, title: "Second chat" } : tab,
      ),
    }));
    return { first, second };
  });
  const second = await openChat();
  await expect(second.locator("[data-panel-window-title]")).toHaveText(
    "Second chat",
  );
  await expect(first.locator("[data-panel-window-title]")).toHaveText(
    "Review manuscript comments",
  );
  await expect(first.locator("[data-chat-composer-input]:visible")).toHaveValue(
    "First draft",
  );
  // An empty popped-out chat must not be discarded when another chat is selected.
  await page.evaluate(async (ids) => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    store.getState().setActiveTab(ids.first);
  }, ids);
  await expect(second.locator("[data-panel-window-title]")).toHaveText(
    "Second chat",
  );
  await second
    .locator("[data-chat-composer-input]:visible")
    .fill("Second draft");
  await expect(first.locator("[data-chat-composer-input]:visible")).toHaveValue(
    "First draft",
  );
  await expect(
    page
      .locator("[data-workspace-chat-pane]")
      .locator("[data-chat-composer-input]:visible"),
  ).toHaveValue("First draft");
  await page.evaluate(async (ids) => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore: store } = await import(/* @vite-ignore */ url);
    store.getState()._appendMessage(ids.second, {
      type: "user",
      provider: "claude",
      model: "claude-sonnet-4-6",
      reasoningEffort: "high",
      message: {
        content: [{ type: "text", text: "Message only for second" }],
      },
    });
  }, ids);
  await expect(second.locator("[data-chat-title-current]")).toHaveText(
    "ClaudeSonnet 4.6 · High",
  );
  await expect(first.locator("[data-chat-title-current]")).toHaveText(
    "CodexGPT-6.1-Sol · High",
  );
  await expect(
    second.getByText("Message only for second", { exact: true }),
  ).toBeVisible();
  await expect(
    first.getByText("Message only for second", { exact: true }),
  ).toHaveCount(0);
  const before = page.context().pages().length;
  await page
    .getByRole("button", { name: "More Chat view actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Pop out Chat", exact: true })
    .click();
  expect(page.context().pages()).toHaveLength(before);
  await first.screenshot({
    path: test.info().outputPath("pinned-first-chat.png"),
    animations: "disabled",
  });
  await second.screenshot({
    path: test.info().outputPath("pinned-second-chat.png"),
    animations: "disabled",
  });
  await first.close();
  const reopened = await openChat();
  await expect(
    reopened.locator("[data-chat-composer-input]:visible"),
  ).toHaveValue("First draft");
  await second.close();
  await reopened.close();
});

test("Antigravity is opt-in and labels the selected model in Full chat", async ({
  page,
}) => {
  const models = [
    { value: "gemini-fixture-high", label: "Gemini Fixture (High)" },
    { value: "gemini-fixture-medium", label: "Gemini Fixture (Medium)" },
    { value: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)" },
  ];
  const retiredModel = "gemini-fixture-retired";
  const setAntigravityModel = (id: string) =>
    page.evaluate(async (value) => {
      const url = performance
        .getEntriesByType("resource")
        .find((entry) =>
          new URL(entry.name).pathname.endsWith("/settings-store.ts"),
        )!.name;
      const { useSettingsStore } = await import(/* @vite-ignore */ url);
      useSettingsStore.setState({ antigravityModel: value });
    }, id);
  const savedAntigravityModel = () =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("catalex-settings") ?? "{}").state
          ?.antigravityModel,
    );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=claude-models&section=agent&provider=antigravity");
  const tabs = page.getByRole("tablist", { name: "Agent provider" });
  await expect(tabs.getByRole("tab")).toHaveText([
    /^Codex/,
    /^Claude Code/,
    /^Antigravity/,
    /^Pi/,
  ]);
  await tabs.getByRole("tab", { name: /^Antigravity/ }).press("End");
  await expect(tabs.getByRole("tab", { name: /^Pi/ })).toBeFocused();
  await tabs.getByRole("tab", { name: /^Pi/ }).press("ArrowLeft");
  await expect(tabs.getByRole("tab", { name: /^Antigravity/ })).toBeFocused();
  const enable = page.getByRole("switch", { name: "Enable Antigravity" });
  await expect(enable).toHaveAttribute("aria-checked", "false");
  await page.evaluate((catalog) => {
    const bridge = (window as Window & { __TAURI_INTERNALS__: BrowserHarness })
      .__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    let empty = true;
    bridge.invoke = async (command, args) => {
      if (command !== "check_antigravity_status") return invoke(command, args);
      const models = empty ? [] : catalog;
      empty = false;
      return { installed: true, models };
    };
  }, models);
  for (const name of ["Codex", "Claude Code", "Pi"]) {
    await page.getByRole("tab", { name: new RegExp(`^${name}\\b`) }).click();
    const toggle = page.getByRole("switch", { name: `Enable ${name}` });
    if ((await toggle.getAttribute("aria-checked")) === "true")
      await toggle.click();
  }
  await page.getByRole("tab", { name: /^Antigravity/ }).click();
  await enable.click();
  const settings = page.locator("#agent-provider-panel");
  const defaultModel = settings.getByRole("combobox", {
    name: "Default model",
  });
  await expect(defaultModel).toHaveText("CLI default");
  await expect(defaultModel).toBeDisabled();
  await settings.getByRole("button", { name: "Retry" }).click();
  await expect(defaultModel).toBeEnabled();
  await setAntigravityModel(retiredModel);
  await expect(defaultModel).toHaveText(`${retiredModel} (saved default)`);
  await expect.poll(savedAntigravityModel).toBe(retiredModel);
  await defaultModel.click();
  await page
    .getByRole("option", { name: "Gemini Fixture", exact: true })
    .click();
  const level = settings.getByRole("combobox", { name: "Thinking level" });
  await expect(level).toHaveText("Medium");
  await level.click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await expect.poll(savedAntigravityModel).toBe("gemini-fixture-high");
  await defaultModel.click();
  await page
    .getByRole("option", { name: "Orchestrator (Neon)", exact: true })
    .click();
  await expect(level).toHaveText("Default");
  await level.click();
  await expect(page.getByRole("option")).toHaveText(["Default"]);
  await page.getByRole("option", { name: "Default", exact: true }).click();
  await defaultModel.click();
  await page
    .getByRole("option", { name: "Gemini Fixture", exact: true })
    .click();
  await expect(level).toHaveText("Medium");
  await expect(settings.getByText("Antigravity executable")).toHaveCount(0);
  await page.getByRole("tab", { name: /^Codex/ }).click();
  await page.getByRole("switch", { name: "Enable Codex" }).click();

  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer" })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const pane = page.locator("[data-workspace-chat-pane]");
  await expect(pane.locator("[data-chat-composer-shell]")).toHaveAttribute(
    "data-composer-transfer-phase",
    "idle",
  );
  await page.evaluate(async (catalog) => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/antigravity-setup-store.ts",
      )!.name;
    const { useAntigravitySetupStore } = await import(/* @vite-ignore */ url);
    useAntigravitySetupStore.setState({
      status: "ready",
      error: null,
      models: catalog,
      options: [
        {
          category: "model",
          currentValue: "gemini-fixture",
          options: [{ value: "gemini-fixture", name: "Gemini Fixture" }],
        },
        {
          category: "thought_level",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
      ],
    });
  }, models);
  await pane.getByRole("button", { name: /Model settings/ }).click();
  await page
    .getByRole("group", { name: "Provider", exact: true })
    .getByRole("button", { name: "Antigravity", exact: true })
    .click();
  await setAntigravityModel(retiredModel);
  await expect(
    page.getByRole("button", {
      name: `${retiredModel} (saved default)`,
      exact: true,
    }),
  ).toHaveClass(/bg-accent/);
  await expect.poll(savedAntigravityModel).toBe(retiredModel);
  await setAntigravityModel("");
  const model = page.getByRole("button", {
    name: "Gemini Fixture",
    exact: true,
  });
  await expect(model).toHaveClass(/bg-accent/);
  const effort = page.getByRole("group", { name: "Effort" });
  await expect(effort.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect.poll(savedAntigravityModel).toBe("");
  await model.click();
  await expect(effort.getByRole("button")).toHaveText(["M", "H"]);
  const orchestrator = page.getByRole("button", {
    name: "Orchestrator (Neon)",
    exact: true,
  });
  await orchestrator.click();
  await expect(orchestrator).toHaveClass(/bg-accent/);
  await expect(effort.getByRole("button")).toHaveText(["Default"]);
  await expect(effort.getByRole("button", { name: "Default" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("catalex-settings") ?? "{}").state
            ?.antigravityModel,
      ),
    )
    .toBe("gemini-pro-orchestrator-neon");
  await model.click();
  await expect(effort.getByRole("button", { name: "Medium" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await effort.getByRole("button", { name: "High" }).click();
  await expect.poll(savedAntigravityModel).toBe("gemini-fixture-high");
  await page.keyboard.press("Escape");
  await pane.getByRole("button", { name: "Permission", exact: true }).click();
  const menu = page.getByRole("group", { name: "Agent permission" });
  await expect(menu.getByRole("button")).toHaveText([
    "Ask for approval",
    "Allow edits",
    "Approve for me",
    "Same as CLI setting",
  ]);
  await expect(menu.locator("button > svg.lucide-shield-half")).toHaveCount(1);
  await expect(
    menu.getByRole("button", { name: "Approve for me" }),
  ).toHaveAttribute("aria-pressed", "true");
  const writing = page.getByRole("group", { name: "Writing permission" });
  await writing.getByRole("button", { name: "Auto-apply" }).click();
  await expect(
    writing.getByRole("button", { name: "Auto-apply" }),
  ).toHaveAttribute("aria-pressed", "true");
  await menu.getByRole("button", { name: "Same as CLI setting" }).click();
  await expect(
    menu.getByRole("button", { name: "Same as CLI setting" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const bridge = (window as Window & { __TAURI_INTERNALS__: BrowserHarness })
      .__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (command, args, options) => {
      const { projectPath, provider } = (args ?? {}) as Record<string, string>;
      if (command !== "slash_commands_list" || provider !== "antigravity") {
        return invoke(command, args, options);
      }
      return [
        {
          id: "skill-fixture",
          name: "Fixture skill",
          full_command: "/fixture-skill",
          scope: "skill",
          file_path: `${projectPath}/.agents/skills/fixture-skill/SKILL.md`,
          content: "Fixture skill instructions",
        },
      ];
    };
  });
  const input = pane.locator("[data-chat-composer-input]:visible");
  await input.fill("/fixture");
  await expect(
    page.getByRole("button", { name: /\/fixture-skill.*Local Skills/ }),
  ).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue("/fixture-skill ");
  await input.fill("");

  await page.evaluate(async () => {
    const url = (name: string) =>
      performance
        .getEntriesByType("resource")
        .find(
          (entry) =>
            new URL(entry.name).pathname === `/src/renderer/stores/${name}.ts`,
        )!.name;
    const { useAgentChatStore } = await import(
      /* @vite-ignore */ url("agent-chat-store")
    );
    const { useSettingsStore } = await import(
      /* @vite-ignore */ url("settings-store")
    );
    const chat = useAgentChatStore.getState();
    chat._appendMessage(chat.activeTabId, {
      type: "user",
      provider: chat.selectedProvider,
      model: useSettingsStore.getState().antigravityModel,
      message: { content: [{ type: "text", text: "Reply from the fixture" }] },
    });
  });
  await expect(
    pane.locator("[data-chat-title-current] [data-chat-last-provider]"),
  ).toHaveText("Antigravity");
  await expect(
    pane.locator("[data-chat-title-current] [data-chat-last-model]"),
  ).toHaveText("Gemini Fixture · High");
  await expect(pane.locator("[data-chat-model-divider]").last()).toHaveText(
    "Antigravity · Gemini Fixture · High",
  );
});

test("provider and writing permissions share one menu and a paused draft shows its saved mode", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=claude-models&section=agent&provider=codex");
  await page.getByRole("combobox", { name: "Agent permission" }).click();
  await expect(
    page
      .getByRole("option", { name: "Ask for approval" })
      .locator("svg.lucide-shield-question-mark"),
  ).toBeVisible();
  await page.getByRole("option", { name: "Ask for approval" }).click();
  await page.goto("/?debug=comment-workspace");
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer" })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const pane = page.locator("[data-workspace-chat-pane]");
  await expect(pane.locator("[data-chat-composer-shell]")).toHaveAttribute(
    "data-composer-transfer-phase",
    "idle",
  );
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        ({ name }) =>
          new URL(name).pathname === "/src/renderer/stores/agent-chat-store.ts",
      )!.name;
    const { useAgentChatStore } = await import(/* @vite-ignore */ url);
    useAgentChatStore.setState((state: any) => ({
      selectedProvider: "codex",
      tabs: state.tabs.map((tab: any) =>
        tab.id === state.activeTabId
          ? {
              ...tab,
              provider: "codex",
              sessionId: null,
              providerSessionIds: {},
              pauseState: "paused",
              draft: { input: "", pinnedContexts: [] },
              agentWorkspace: {
                version: 2,
                sessionId: "paused-demo",
                tabId: tab.id,
                projectRoot: "/browser-demo/Comment Review",
                candidateRoot: "/demo/draft",
                mode: "edit",
                status: "active",
                warnings: [],
              },
            }
          : tab,
      ),
    }));
  });
  const button = pane
    .getByRole("button", { name: "Permission", exact: true })
    .first();
  await expect(button).toHaveAccessibleDescription(
    "Agent permission · Ask for approval / Writing permission · Need approval",
  );
  await expect(button.locator(":scope > svg.lucide-thumbs-up")).toBeVisible();
  await expect(
    button.locator("g > svg.lucide-shield-question-mark"),
  ).toHaveCount(1);
  await expect(
    pane.getByText("This draft: Auto-apply", { exact: true }),
  ).toBeVisible();
  await button.click();
  const agent = page.getByRole("group", {
    name: "Agent permission",
    exact: true,
  });
  const writing = page.getByRole("group", {
    name: "Writing permission",
    exact: true,
  });
  await expect(agent.getByRole("button")).toHaveText([
    "Ask for approval",
    "Approve for me",
    "Same as CLI setting",
  ]);
  await expect(
    agent.locator("button > svg.lucide-shield-question-mark"),
  ).toHaveCount(1);
  await expect(
    agent.locator("button > svg.lucide-shield-ellipsis"),
  ).toHaveCount(1);
  await expect(
    agent.locator("button > svg.lucide-square-terminal"),
  ).toHaveCount(1);
  await expect(
    agent.getByRole("button", { name: "Ask for approval" }),
  ).toHaveAttribute("aria-pressed", "true");
  await agent.getByRole("button", { name: "Approve for me" }).click();
  await expect(
    agent.getByRole("button", { name: "Approve for me" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("catalex-settings") ?? "{}").state
            ?.agentPermissions?.codex,
      ),
    )
    .toBe("never");
  await writing.getByRole("button", { name: "Auto-apply" }).click();
  await writing.getByRole("button", { name: "Need approval" }).click();
  await expect(
    pane.getByText("This draft: Auto-apply", { exact: true }),
  ).toBeVisible();
  const cli = agent.getByRole("button", { name: "Same as CLI setting" });
  await expect(cli).toBeEnabled();
  await cli.click();
  await page.evaluate(async () => {
    const load = (module: string) =>
      import(
        performance
          .getEntriesByType("resource")
          .find(({ name }) => new URL(name).pathname.endsWith(`/${module}.ts`))!
          .name
      );
    const { useAgentChatStore } = await load("agent-chat-store");
    const { useSettingsStore } = await load("settings-store");
    const settings = useSettingsStore.getState();
    settings.setAgentPermission("codex", "cli");
    useAgentChatStore.setState((state: any) => ({
      tabs: state.tabs.map((tab: any) =>
        tab.id === state.activeTabId
          ? {
              ...tab,
              sessionId: "fixture-thread",
              providerSessionIds: { codex: "fixture-thread" },
            }
          : tab,
      ),
    }));
  });
  await expect(cli).toBeEnabled();
  await expect(cli).toHaveAttribute("aria-pressed", "true");
  const ask = agent.getByRole("button", { name: "Ask for approval" });
  await ask.click();
  await expect(ask).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("catalex-settings") ?? "{}").state
          ?.agentPermissions.codex,
    ),
  ).toBe("on-request");
  await page.evaluate(async () => {
    const { useSettingsStore } = await import(
      performance
        .getEntriesByType("resource")
        .find(({ name }) =>
          new URL(name).pathname.endsWith("/settings-store.ts"),
        )!.name
    );
    useSettingsStore
      .getState()
      .recordCodexExplicitPolicy("fixture-thread", "on-request");
  });
  await expect(cli).toBeDisabled();
  await cli.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Available in a new chat. Codex keeps this chat’s approval setting.",
  );
  await page.screenshot({
    path: test.info().outputPath("permission-menu.png"),
  });
});

test("the composer overlaps permission icons at both widths and lists Pi last @core", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer" })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const pane = page.locator("[data-workspace-chat-pane]");
  const button = pane.getByRole("button", { name: "Permission", exact: true });
  const writing = button.locator(":scope > svg");
  const mask = button.locator("g[mask]");
  const halo = button.locator("mask > svg");
  const gap = () =>
    button.evaluate((trigger) => {
      const [agent, writing] = Array.from(trigger.children, (icon) =>
        icon.getBoundingClientRect(),
      );
      return Math.round(writing.left - agent.right);
    });
  await expect.poll(gap).toBe(-6);
  await expect(mask).toHaveCSS("mask-image", /^url\(/);
  await expect(halo).toHaveAttribute("stroke-width", "9");
  await page.setViewportSize({ width: 345, height: 900 });
  await expect.poll(gap).toBe(-6);
  await expect(mask).toHaveCSS("mask-image", /^url\(/);
  await expect(halo).toHaveAttribute("stroke-width", "9");
  await expect(writing).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(({ name }) =>
        new URL(name).pathname.endsWith("/settings-store.ts"),
      )!.name;
    const { useSettingsStore } = await import(/* @vite-ignore */ url);
    useSettingsStore.setState({
      enabledProviders: {
        codex: true,
        claude: true,
        antigravity: true,
        pi: true,
      },
    });
  });
  await pane.getByRole("button", { name: /Model settings/ }).click();
  await expect(
    page
      .getByRole("group", { name: "Provider", exact: true })
      .getByRole("button"),
  ).toHaveText(["Codex", "Claude", "Antigravity", "Pi"]);
});
