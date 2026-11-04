import { expect, test } from "@playwright/test";

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
  await chat.getByPlaceholder("Ask me anything").fill("Shared pop-out draft");
  await expect(
    page
      .locator("[data-workspace-chat-pane]")
      .getByPlaceholder("Ask me anything"),
  ).toHaveValue("Shared pop-out draft");
  await page
    .locator("[data-workspace-chat-pane]")
    .getByPlaceholder("Ask me anything")
    .fill("Updated from the main window");
  await expect(chat.getByPlaceholder("Ask me anything")).toHaveValue(
    "Updated from the main window",
  );
  await chat.getByPlaceholder("Ask me anything").fill("");
  await expect(
    page
      .locator("[data-workspace-chat-pane]")
      .getByPlaceholder("Ask me anything"),
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
  await first.getByPlaceholder("Ask me anything").fill("First draft");
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
  await expect(first.getByPlaceholder("Ask me anything")).toHaveValue(
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
  await second.getByPlaceholder("Ask me anything").fill("Second draft");
  await expect(first.getByPlaceholder("Ask me anything")).toHaveValue(
    "First draft",
  );
  await expect(
    page
      .locator("[data-workspace-chat-pane]")
      .getByPlaceholder("Ask me anything"),
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
  await expect(reopened.getByPlaceholder("Ask me anything")).toHaveValue(
    "First draft",
  );
  await second.close();
  await reopened.close();
});
