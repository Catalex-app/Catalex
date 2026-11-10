import { expect, test } from "@playwright/test";

interface TransferCheck {
  name: "drawer_to_workspace" | "workspace_to_drawer";
  pass: boolean;
  sourceExitStartFrame: number;
  targetEnterPrepStartFrame: number;
  targetEnterStartFrame: number;
  maxSourceTranslateY: number;
  minSourceOpacity: number;
  maxTargetTranslateY: number;
  finalTargetTranslateY: number;
  finalTargetOpacity: number;
  totalFrames: number;
  targetModeReached: boolean;
}

interface InputTransferHarnessReport {
  pass: boolean;
  checks: TransferCheck[];
  finishedAtIso: string;
}

declare global {
  interface Window {
    __runInputTransferHarness?: () => Promise<InputTransferHarnessReport>;
    __inputTransferHarnessReport?: InputTransferHarnessReport;
    __selectInputTransferHarnessText?: (text: string) => boolean;
    __getInputTransferHarnessSelectionState?: () => {
      selectionRange: { start: number; end: number } | null;
      selectionPreviewRange: {
        fileId: string;
        start: number;
        end: number;
      } | null;
    };
  }
}

test("removing a hovered selection chip clears its editor highlight", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.locator(".cm-editor")).toBeVisible();
  const selected = await page.evaluate(() => {
    return window.__selectInputTransferHarnessText?.("Hello harness");
  });
  expect(selected).toBe(true);

  const chip = page.locator(
    '[data-chat-drawer-panel="true"] [data-selection-chip="true"]:visible',
  );
  await expect(chip).toHaveCount(1);
  await chip.hover();
  await expect(page.locator(".cm-selectionChipPreview")).toHaveCount(1);
  expect(
    await page.evaluate(() => {
      return window.__getInputTransferHarnessSelectionState?.()
        .selectionPreviewRange;
    }),
  ).toEqual({ fileId: "main.tex", start: 81, end: 94 });

  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((element) => element.remove());
  await page.screenshot({
    path: "test-results/selection-chip-hover-preview.png",
    fullPage: true,
  });

  await chip.getByRole("button", { name: "Remove context" }).click();

  await expect(chip).toHaveCount(0);
  await expect(page.locator(".cm-selectionChipPreview")).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      return window.__getInputTransferHarnessSelectionState?.()
        .selectionPreviewRange;
    }),
  ).toBeNull();
  await page.screenshot({
    path: "test-results/selection-chip-removed-preview.png",
    fullPage: true,
  });
});

test("Artisan defaults to Classic without changing its editor workflow", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await page.getByRole("tab", { name: "Artisan", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-ui-theme",
    "classic",
  );
  const viewModes = page.getByRole("tablist", { name: "Workspace view mode" });
  const selectedView = viewModes.locator('[role="tab"][aria-selected="true"]');
  await expect(selectedView).toBeVisible();
  await expect
    .poll(() =>
      selectedView.evaluate((el) => getComputedStyle(el).backgroundImage),
    )
    .toContain("linear-gradient");
  const editorView = viewModes.getByRole("tab", {
    name: "Editor",
    exact: true,
  });
  await editorView.click();
  await expect(editorView).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-editor")).toBeVisible();
});

test("drawer/workspace input transfer harness validates composer handoff", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleMessages: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack || error.message);
  });
  page.on("console", (message) => {
    consoleMessages.push(`${message.type()}: ${message.text()}`);
  });

  await page.goto("/?debug=input-transfer", {
    waitUntil: "domcontentloaded",
  });

  // Wait for startup/pageshow recovery before measuring a user transition.
  // That recovery deliberately cancels any animations already in flight.
  await expect(page.locator("#loading-screen")).toHaveCount(0);

  const hasHarnessFn = await page
    .waitForFunction(
      () => typeof window.__runInputTransferHarness === "function",
      undefined,
      { timeout: 10_000 },
    )
    .then(
      () => true,
      () => false,
    );
  if (!hasHarnessFn) {
    const debugInfo = await page.evaluate(() => ({
      readyState: document.readyState,
      bodyText: document.body?.innerText?.slice(0, 600) ?? "",
      location: window.location.href,
    }));
    throw new Error(
      `Harness bootstrap missing. pageErrors=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleMessages)} debug=${JSON.stringify(debugInfo)}`,
    );
  }

  const report = await page.evaluate(async () => {
    return await window.__runInputTransferHarness?.();
  });

  expect(
    pageErrors,
    `page errors: ${JSON.stringify(pageErrors, null, 2)}`,
  ).toEqual([]);
  expect(report).toBeTruthy();
  expect(report?.checks.length ?? 0).toBe(2);
  const failedChecks = (report?.checks ?? []).filter((check) => !check.pass);
  expect(
    failedChecks,
    `failed checks: ${JSON.stringify(failedChecks, null, 2)}; full=${JSON.stringify(report, null, 2)}`,
  ).toEqual([]);
  expect(report?.pass).toBe(true);
});

test("layout switches and new chats share one default permission", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  const expectManual = async (panel: string) => {
    const trigger = page
      .locator(panel)
      .getByRole("button", { name: "Writing permission", exact: true });
    await trigger.click();
    const popup = page.getByRole("dialog", {
      name: "Writing permission",
      exact: true,
    });
    await expect(
      popup.getByRole("button", { name: "Need approval", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await popup.press("Escape");
    await expect(trigger).toBeFocused();
  };
  await expectManual("[data-chat-drawer-panel]");
  await page.waitForTimeout(800);
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
    "data-chat-layout",
    "workspace",
  );
  await expectManual("[data-workspace-chat-pane]");
  await page.evaluate(() => window.__newInputTransferChat?.());
  await expectManual("[data-workspace-chat-pane]");
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
    "data-chat-layout",
    "drawer",
  );
  await expectManual("[data-chat-drawer-panel]");
  await page.evaluate(() => window.__newInputTransferChat?.());
  await expectManual("[data-chat-drawer-panel]");
});

test("removing a badge while typing preserves chat focus and caret", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.evaluate(() =>
    window.__selectInputTransferHarnessText?.("Hello harness"),
  );
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const chip = drawer.locator('[data-selection-chip="true"]:visible');
  await expect(chip).toHaveCount(1);
  const input = drawer.locator("textarea:visible");
  await input.fill("Please explain");
  await input.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(2, 2),
  );
  await chip.getByRole("button", { name: "Remove context" }).click();
  await expect(chip).toHaveCount(0);
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([2, 2]);
  await page.keyboard.type("X");
  await expect(input).toHaveValue("PlXease explain");
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((element) => element.remove());
  await page.screenshot({
    path: test.info().outputPath("badge-removed-input-focused.png"),
  });
});

test("one header retains independent Git and rewind controls across all modes", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.waitForTimeout(500); // Fixture project/mode initialization.
  const git = page.locator("[data-workspace-header-git]");
  const rewind = page.getByRole("button", { name: "Rewind", exact: true });
  await expect(git).toHaveCount(1);
  await expect(rewind).toHaveCount(1);
  const originalGit = await git.elementHandle();
  const originalRewind = await rewind.elementHandle();
  for (const mode of ["Full", "Artisan", "Duet", "Half", "Full"]) {
    if (mode === "Full")
      await page
        .getByRole("button", { name: "Toggle drawer", exact: true })
        .locator("..")
        .hover();
    await page
      .getByRole(mode === "Artisan" || mode === "Duet" ? "tab" : "button", {
        name: mode,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("tab", {
        name: mode === "Artisan" ? "Artisan" : "Duet",
        exact: true,
      }),
    ).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(900);
    expect(
      await originalGit!.evaluate(
        (node) =>
          node === document.querySelector("[data-workspace-header-git]"),
      ),
    ).toBe(true);
    expect(
      await originalRewind!.evaluate(
        (node) => node === document.querySelector('[aria-label="Rewind"]'),
      ),
    ).toBe(true);
    for (const handle of [originalGit!, originalRewind!]) {
      expect(
        await handle.evaluate((node) => {
          for (
            let current: Element | null = node;
            current;
            current = current.parentElement
          ) {
            const style = getComputedStyle(current);
            if (
              Number(style.opacity) < 1 ||
              style.visibility === "hidden" ||
              style.display === "none"
            )
              return false;
          }
          return true;
        }),
      ).toBe(true);
    }
  }
  const headerContent = page.locator(
    "[data-workspace-header] [data-git-actions-compact-root]",
  );
  const beforeResize = await headerContent.boundingBox();
  const seam = await page
    .locator('[data-panel-resize-handle-enabled="true"]:visible')
    .first()
    .boundingBox();
  await page.mouse.move(seam!.x + seam!.width / 2, seam!.y + 30);
  await page.mouse.down();
  await page.mouse.move(seam!.x - 80, seam!.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await headerContent.boundingBox())!.x)
    .toBeLessThan(beforeResize!.x - 30);
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page
    .getByRole("button", { name: "More PDF view actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Expand PDF", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "PDF expanded", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore PDF", exact: true }).click();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(git).toBeVisible();
  await expect(rewind).toBeVisible();
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await page.screenshot({ path: "test-results/shared-header-narrow-vibe.png" });
});

test("sidebar changes with composer exit before workspace panels switch", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.waitForTimeout(500);
  for (const [target, source, sidebar, phase] of [
    ["Full", "drawer", "sessions", "drawer_exit"],
    ["Half", "workspace", "files", "panel_exit"],
  ]) {
    const start = await page.evaluate(async (target) => {
      const tab = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "button[data-chat-display]",
        ),
      ).find((node) => node.textContent?.trim() === target)!;
      tab.click();
      await new Promise(requestAnimationFrame);
      return {
        sidebar: document
          .querySelector("[data-sidebar-content-stack]")
          ?.getAttribute("data-sidebar-content-stack"),
        workspace: document
          .querySelector("[data-workspace-mode-area]")
          ?.getAttribute("data-chat-layout"),
        phases: Array.from(
          document.querySelectorAll("[data-chat-composer-shell]"),
        ).map((node) => node.getAttribute("data-composer-transfer-phase")),
        moving: document
          .querySelector("[data-workspace-layout-animating]")
          ?.getAttribute("data-workspace-layout-animating"),
      };
    }, target);
    expect(start.sidebar).toBe(sidebar);
    expect(start.workspace).toBe(source);
    expect(start.phases).toContain(phase);
    expect(start.moving).toBe("false");
    await page.waitForTimeout(950);
    await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
      "data-chat-layout",
      target === "Full" ? "workspace" : "drawer",
    );
  }
});

test("chat layout preserves a running session, model, permission, and draft", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page.waitForTimeout(800);
  const before = await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const { useAgentChatStore } = await import(path);
    const state = useAgentChatStore.getState();
    state.setSelectedCodexModel("demo");
    state.setSelectedCodexExecutionMode("edit");
    const next = useAgentChatStore.getState();
    const tabs = next.tabs.map((tab: { id: string; draft: object }) =>
      tab.id === next.activeTabId
        ? {
            ...tab,
            isStreaming: true,
            sessionId: "layout-session",
            draft: { ...tab.draft, input: "Keep my next question" },
          }
        : tab,
    );
    useAgentChatStore.setState({ tabs, isStreaming: true });
    return {
      activeTabId: next.activeTabId,
      tab: tabs.find((tab: { id: string }) => tab.id === next.activeTabId),
      model: next.selectedCodexModel,
      permission: next.selectedCodexExecutionMode,
    };
  });
  for (const [button, layout] of [
    ["Full", "workspace"],
    ["Half", "drawer"],
  ]) {
    if (button === "Full")
      await page
        .getByRole("button", { name: "Toggle drawer", exact: true })
        .locator("..")
        .hover();
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
      "data-chat-layout",
      layout,
    );
    await expect(
      page.getByRole("tab", { name: "Duet", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const after = await page.evaluate(async () => {
      const path = "/src/renderer/stores/agent-chat-store.ts";
      const { useAgentChatStore } = await import(path);
      const state = useAgentChatStore.getState();
      return {
        activeTabId: state.activeTabId,
        tab: state.tabs.find(
          (tab: { id: string }) => tab.id === state.activeTabId,
        ),
        model: state.selectedCodexModel,
        permission: state.selectedCodexExecutionMode,
      };
    });
    expect(after).toEqual(before);
  }
});

for (const provider of ["claude", "codex"] as const) {
  test(`layout switches preserve a non-default ${provider} agent in an idle chat`, async ({
    page,
  }) => {
    await page.goto("/?debug=input-transfer");
    await expect(page.locator("#loading-screen")).toHaveCount(0);
    await page.waitForTimeout(800);
    await page
      .getByRole("button", { name: "Toggle drawer", exact: true })
      .locator("..")
      .hover();
    await page.getByRole("button", { name: "Full", exact: true }).click();
    await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
      "data-chat-layout",
      "workspace",
    );
    await page.waitForTimeout(600);
    await page.evaluate(async (selected) => {
      const settingsPath = "/src/renderer/stores/settings-store.ts";
      const chatPath = "/src/renderer/stores/agent-chat-store.ts";
      const { useSettingsStore } = await import(settingsPath);
      const { useAgentChatStore } = await import(chatPath);
      useSettingsStore.setState({
        enabledProviders: { claude: true, codex: true },
        defaultAgent: selected === "claude" ? "codex" : "claude",
      });
      useAgentChatStore.getState().setProvider(selected);
    }, provider);
    const snapshot = () =>
      page.evaluate(async () => {
        const path = "/src/renderer/stores/agent-chat-store.ts";
        const { useAgentChatStore } = await import(path);
        const state = useAgentChatStore.getState();
        const tab = state.tabs.find(
          (item: { id: string }) => item.id === state.activeTabId,
        );
        return {
          provider: state.selectedProvider,
          tabProvider: tab?.provider,
          tabId: state.activeTabId,
          claudeModel: state.selectedClaudeModel,
          codexModel: state.selectedCodexModel,
          streaming: state.isStreaming,
        };
      });
    const before = await snapshot();
    expect(before.provider).toBe(provider);
    expect(before.tabProvider).toBe(provider);
    expect(before.streaming).toBe(false);
    for (const display of ["Half", "Mini", "Full", "Mini", "Half", "Full"]) {
      if (
        await page
          .getByRole("button", { name: "Toggle drawer", exact: true })
          .isVisible()
      ) {
        await page
          .getByRole("button", { name: "Toggle drawer", exact: true })
          .locator("..")
          .hover();
      }
      await page.getByRole("button", { name: display, exact: true }).click();
      await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
        "data-chat-layout",
        display === "Full" ? "workspace" : "drawer",
      );
      await page.waitForTimeout(600);
      expect(await snapshot()).toEqual(before);
    }
  });
}

test("switching chat displays preserves a focused caret or selection", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  const drawer = page.locator("[data-chat-drawer-panel]");
  const drawerInput = drawer.locator("[data-chat-composer-input]");
  const fullInput = page.locator(
    "[data-workspace-chat-pane] [data-chat-composer-input]",
  );
  const draft = "Please review the introduction.";
  await drawerInput.fill(draft);
  await drawerInput.evaluate((input: HTMLTextAreaElement) => {
    input.setSelectionRange(7, 7);
  });
  await drawer.getByRole("button", { name: "Toggle drawer" }).click();
  await expect(drawer.locator("[data-chat-messages]")).toBeVisible();
  await expect(drawerInput).toBeFocused();
  expect(
    await drawerInput.evaluate((input: HTMLTextAreaElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([7, 7]);

  await drawerInput.evaluate((input: HTMLTextAreaElement) => {
    input.setSelectionRange(7, 13, "backward");
  });
  for (const [source, mode, input] of [
    ["Half", "Full", fullInput],
    ["Full", "Mini", drawerInput],
    ["Mini", "Full", fullInput],
    ["Full", "Half", drawerInput],
    ["Half", "Mini", drawerInput],
  ] as const) {
    if (mode === "Full" && (await drawer.isVisible())) {
      await drawer
        .getByRole("button", { name: "Toggle drawer" })
        .locator("..")
        .hover();
    }
    await page.getByRole("button", { name: mode, exact: true }).click();
    if (source === "Full") {
      const visibility = await page.waitForFunction(() => {
        const panel = document
          .querySelector(
            '[data-chat-composer-shell][data-composer-transfer-phase="drawer_enter_prep"]',
          )
          ?.closest("[data-chat-drawer-panel]");
        return panel && getComputedStyle(panel).visibility;
      });
      expect(await visibility.jsonValue()).toBe("visible");
    }
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(draft);
    expect(
      await input.evaluate((input: HTMLTextAreaElement) => [
        input.selectionStart,
        input.selectionEnd,
        input.selectionDirection,
      ]),
    ).toEqual([7, 13, "backward"]);
  }
});

test("Full to Half keeps the drawer stationary when showing a chat with history", async ({
  page,
}) => {
  await page.goto("/?onboarding-demo&project&chats");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page.waitForTimeout(800);
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await page.waitForTimeout(800);
  await expect(
    page.getByText("Here is a possible opening:").filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.locator("[data-workspace-chat-pane] textarea"),
  ).not.toBeFocused();
  const samples = await page.evaluate(async () => {
    const duet = document.querySelector<HTMLElement>(
      '[data-chat-display="Expanded"]',
    );
    duet!.click();
    const positions: number[] = [];
    const opacities: number[] = [];
    const start = performance.now();
    while (performance.now() - start < 1200) {
      await new Promise(requestAnimationFrame);
      const panel = document.querySelector<HTMLElement>(
        '[data-chat-drawer-panel="true"]',
      );
      if (panel) positions.push(panel.scrollTop);
      const history = panel?.querySelector(
        "[data-chat-messages] [data-virtuoso-scroller]",
      );
      const message = history?.querySelector("[data-message-index]");
      if (
        history &&
        message &&
        getComputedStyle(message).visibility !== "hidden"
      )
        opacities.push(Number(getComputedStyle(history).opacity));
    }
    return { positions, opacities };
  });
  expect(samples.positions.length).toBeGreaterThan(5);
  expect(Math.max(...samples.positions)).toBe(0);
  expect(samples.opacities).toContain(0);
  expect(samples.opacities.some((value) => value > 0 && value < 1)).toBe(true);
  expect(samples.opacities.at(-1)).toBe(1);
  const input = page.locator('[data-chat-drawer-panel="true"] textarea');
  await expect(input).not.toBeFocused();
  await page.keyboard.press("ControlOrMeta+t");
  await expect(input).toBeFocused();
});

test("Duet remembers expanded and collapsed drawer states across mode switches", async ({
  page,
}) => {
  await page.goto("/?onboarding-demo&project&chats");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page.waitForTimeout(800);
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  await expect(drawer.locator("[data-chat-messages]")).toBeVisible();
  for (const expanded of [true, false]) {
    if (!expanded) {
      await page
        .getByRole("button", { name: "Toggle drawer", exact: true })
        .locator("..")
        .hover();
      await page.getByRole("button", { name: "Mini", exact: true }).click();
      await expect(drawer.locator("[data-chat-messages]")).toHaveCount(0);
    }
    for (const mode of ["Artisan"]) {
      await page.getByRole("tab", { name: mode, exact: true }).click();
      await page.waitForTimeout(800);
      await page.getByRole("tab", { name: "Duet", exact: true }).click();
      await page.waitForTimeout(900);
      if (expanded)
        await expect(drawer.locator("[data-chat-messages]")).toBeVisible();
      else await expect(drawer.locator("[data-chat-messages]")).toHaveCount(0);
    }
  }
});

test("drawer history shares its reveal fade across expansion and chat selection", async ({
  page,
}) => {
  await page.goto("/?onboarding-demo&project&chats");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page.waitForTimeout(800);
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Mini", exact: true }).click();
  await page.waitForTimeout(250);
  for (const action of ["expand", "switch"]) {
    const samples = await page.evaluate(async (action) => {
      const panel = document.querySelector<HTMLElement>(
        '[data-chat-drawer-panel="true"]',
      )!;
      if (action === "expand")
        panel
          .querySelector<HTMLButtonElement>('[data-chat-display="Expanded"]')!
          .click();
      else
        [...panel.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent === "Outline the evaluation")!
          .click();
      const opacities: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 900) {
        await new Promise(requestAnimationFrame);
        const history = panel.querySelector(
          "[data-chat-messages] [data-virtuoso-scroller]",
        );
        const message = history?.querySelector("[data-message-index]");
        if (
          history &&
          message &&
          getComputedStyle(message).visibility !== "hidden"
        )
          opacities.push(Number(getComputedStyle(history).opacity));
      }
      return opacities;
    }, action);
    expect(samples.some((opacity) => opacity < 0.5)).toBe(true);
    expect(samples.some((opacity) => opacity > 0 && opacity < 1)).toBe(true);
    expect(samples.at(-1)).toBe(1);
  }
});

test("Half keeps navigation and header actions together while Mini reveals controls upward and Half still resizes", async ({
  page,
}) => {
  await page.goto("/?onboarding-demo&project&chats");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page.waitForTimeout(800);
  const drawer = page.locator("[data-chat-drawer-panel]");
  const handle = page.getByRole("button", {
    name: "Toggle drawer",
    exact: true,
  });
  await page.mouse.move(100, 200);
  await expect(
    page.getByRole("button", { name: "Half", exact: true }),
  ).toBeVisible();
  const halfBeforeHover = (await drawer.boundingBox())!;
  const history = drawer.getByRole("button", {
    name: "Session history",
    exact: true,
  });
  await expect(history).toHaveCount(1);
  const historyBox = (await history.boundingBox())!;
  const navigationBox = (await drawer
    .getByRole("button", { name: "Half", exact: true })
    .boundingBox())!;
  const firstTabBox = (await drawer
    .locator("[data-chat-tab]")
    .first()
    .boundingBox())!;
  expect(historyBox.y + historyBox.height / 2).toBeCloseTo(
    navigationBox.y + navigationBox.height / 2,
    0,
  );
  expect(historyBox.y + historyBox.height).toBeLessThanOrEqual(firstTabBox.y);
  await history.click();
  await expect(page.getByRole("menu")).toContainText("Sessions");
  await page.keyboard.press("Escape");
  expect((await drawer.boundingBox())!.height).toBeCloseTo(
    halfBeforeHover.height,
    0,
  );
  const rowPositions = page.evaluate(async () => {
    const chrome = document.querySelector("[data-chat-drawer-panel]")!
      .firstElementChild!;
    const positions: number[] = [];
    const start = performance.now();
    while (performance.now() - start < 650) {
      positions.push(chrome.getBoundingClientRect().bottom);
      await new Promise(requestAnimationFrame);
    }
    return positions;
  });
  await handle.locator("..").hover();
  const positions = await rowPositions;
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(1);
  expect((await drawer.boundingBox())!.height).toBeCloseTo(
    halfBeforeHover.height,
    0,
  );
  await page.getByRole("button", { name: "Mini", exact: true }).click();
  await page.mouse.move(100, 200);
  await page.waitForTimeout(350);
  const controls = drawer
    .locator('[data-chat-display="Expanded"]')
    .locator("..")
    .locator("..");
  await expect(controls).toHaveCSS("opacity", "0");
  await expect(controls).toHaveAttribute("inert", "");
  const before = (await drawer.boundingBox())!;
  const composer = drawer.locator("[data-chat-composer-shell]");
  const inputBefore = (await composer.boundingBox())!;
  await handle.locator("..").hover();
  await page.waitForTimeout(350);
  const revealed = (await drawer.boundingBox())!;
  expect(revealed.y).toBeLessThan(before.y - 20);
  expect(revealed.y + revealed.height).toBeCloseTo(before.y + before.height, 0);
  expect((await composer.boundingBox())!.y).toBeCloseTo(inputBefore.y, 0);
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await page.waitForTimeout(350);
  await page.mouse.move(100, 200);
  await page.waitForTimeout(350);
  await expect(
    page.getByRole("button", { name: "Half", exact: true }),
  ).toBeVisible();
  const expanded = (await page
    .getByRole("button", { name: "Half", exact: true })
    .boundingBox())!;
  const dragBefore = (await drawer.boundingBox())!;
  const x = expanded.x + expanded.width / 2;
  const y = expanded.y + expanded.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  expect((await drawer.boundingBox())!.height).toBeLessThan(
    dragBefore.height - 20,
  );
  await expect(drawer.locator("[data-chat-messages]")).toBeVisible();
  await page.setViewportSize({ width: 800, height: 800 });
  await expect
    .poll(() =>
      drawer.evaluate((element) => {
        const history = element
          .querySelector('[aria-label="Session history"]')!
          .getBoundingClientRect();
        const mini = element
          .querySelector('[data-chat-display="Collapsed"]')!
          .getBoundingClientRect();
        const full = element
          .querySelector('[data-chat-display="Workspace"]')!
          .getBoundingClientRect();
        const create = element
          .querySelector('[aria-label="New tab"]')!
          .getBoundingClientRect();
        return Math.min(mini.left - history.right, create.left - full.right);
      }),
    )
    .toBeGreaterThanOrEqual(8);
  await drawer.screenshot({
    path: test.info().outputPath("half-sessions-narrow.png"),
  });
});
