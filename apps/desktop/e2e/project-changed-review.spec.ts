import { expect, test, type Page } from "@playwright/test";

async function state(page: Page) {
  return page.evaluate(async () => {
    const loaded = (path: string) =>
      performance
        .getEntriesByType("resource")
        .map((item) => item.name)
        .find((name) => new URL(name).pathname === path) ?? path;
    const { browserHarness } = await import(
      loaded("/src/renderer/lib/desktop/bridge.ts")
    );
    const { useDocumentStore } = await import(
      loaded("/src/renderer/stores/document-store.ts")
    );
    const { useAgentReviewQueueStore } = await import(
      loaded("/src/renderer/stores/agent-review-queue-store.ts")
    );
    return {
      ...(await browserHarness()!.invoke("demo_three_way_state")),
      workspace: useDocumentStore.getState().agentWorkspaceRoot,
      entries: useAgentReviewQueueStore.getState().entries,
    };
  });
}

async function change(page: Page, args: Record<string, unknown>) {
  await page.evaluate(async (args) => {
    const loaded = (path: string) =>
      performance
        .getEntriesByType("resource")
        .map((item) => item.name)
        .find((name) => new URL(name).pathname === path) ?? path;
    const { browserHarness } = await import(
      loaded("/src/renderer/lib/desktop/bridge.ts")
    );
    await browserHarness()!.invoke("demo_external_project_change", args);
    if (args.notify === false) {
      // Dispatch in the same task so a focus refresh cannot win the race.
      const accept = [
        ...document.querySelectorAll<HTMLButtonElement>(
          "[data-proposed-changes-panel] button",
        ),
      ].find((button) => button.getAttribute("aria-label") === "Accept All");
      if (!accept) throw new Error("Acceptance control is missing");
      accept.click();
    }
  }, args);
}

for (const scenario of [
  "external edit",
  "accepted file deleted",
  "accept before notification",
]) {
  test(`${scenario} exits review through the same blocking notice`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/?debug=agent-three-way");
    const panel = page.locator("[data-proposed-changes-panel]");
    await expect(panel).toBeVisible();
    if (scenario === "accepted file deleted") {
      await panel
        .getByRole("button", { name: "Accept All", exact: true })
        .click();
      await expect
        .poll(async () => (await state(page)).pending)
        .toEqual(["checklist.md"]);
      // Notifications for Catalex's own accepted writes must not interrupt the next review.
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(350);
      await expect(
        page.getByRole("dialog", { name: "Project changed externally" }),
      ).toHaveCount(0);
    }
    const before = await state(page);
    if (scenario === "external edit")
      await page
        .getByRole("button", { name: "Simulate external change" })
        .click();
    else
      await change(page, {
        deleted: scenario === "accepted file deleted",
        notify: scenario !== "accept before notification",
      });
    const dialog = page.getByRole("dialog", {
      name: "Project changed externally",
    });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    const stopped = await state(page);
    expect(stopped.entries[0].phase).toBe("question");
    expect(stopped.entries[0].interrupted).toBe(true);
    expect(stopped.discarded).toBe(false);
    expect(stopped.candidate).toEqual(before.candidate);
    await page.screenshot({
      path: test.info().outputPath("project-changed.png"),
    });
    await dialog.getByRole("button", { name: "Got it" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await state(page)).workspace).toBeNull();
    const after = await state(page);
    expect(after.source).toEqual(stopped.source);
    expect(after.pending).toEqual(before.pending);
    expect(after.entries[0].phase).toBe("question");
    expect(after.entries[0].projectChangePending).toBe(false);
    await expect(panel).toHaveCount(0);
  });
}
