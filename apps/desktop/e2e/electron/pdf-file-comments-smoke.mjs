import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-pdf-comments-"),
);
const project = path.join(profile, "PDF project");
const bytes = await fs.readFile(
  path.join(desktopRoot, "public/examples/paper-standard/main.pdf"),
);
for (const dir of ["a", "b"]) {
  await fs.mkdir(path.join(project, dir), { recursive: true });
  await fs.writeFile(path.join(project, dir, "paper.pdf"), bytes);
}
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/electron/pdf-file-comments",
);
await fs.mkdir(artifacts, { recursive: true });
const vite = await createServer({
  root: desktopRoot,
  cacheDir: path.join(profile, "vite-cache"),
  configFile: path.join(desktopRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, hmr: false },
});
await vite.listen();
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];
async function ready(page) {
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  return page;
}
async function launch(filePath = "a/paper.pdf") {
  app = await electron.launch({ args: [desktopRoot], env });
  const page = await ready(await app.firstWindow());
  await page.evaluate(
    async ({ project, filePath }) => {
      const { useOnboardingStore } = await import(
        "/src/renderer/stores/onboarding-store.ts"
      );
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const { useSettingsStore } = await import(
        "/src/renderer/stores/settings-store.ts"
      );
      useOnboardingStore.getState().finish();
      useSettingsStore.setState({ defaultAutoCompile: false });
      await useDocumentStore.getState().closeProject();
      await useDocumentStore.getState().openProject(project);
      useDocumentStore.getState().setActiveFile(filePath);
    },
    { project, filePath },
  );
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible({
    timeout: 15_000,
  });
  return page;
}
async function stored(page) {
  return page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return invoke("read_project_comments_anchored", {
      projectRoot,
      includeDisconnected: true,
    });
  }, project);
}
async function selectPdfText(page, passage = "Your abstract here.") {
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: passage })
    .first();
  await line.scrollIntoViewIfNeeded();
  await page.getByTestId("pdf-scroll-container").focus();
  await line.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}
async function addComment(page, text) {
  await selectPdfText(page);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  await card
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill(text);
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(card.getByText(text, { exact: true })).toBeVisible();
  return card;
}
try {
  let main = await launch();
  await main.getByRole("button", { name: "Fit height", exact: true }).click();
  await addComment(main, "Native PDF comment");
  await expect
    .poll(async () => (await stored(main)).files["a/paper.pdf"]?.[0]?.text)
    .toBe("Native PDF comment");
  let first = (await stored(main)).files["a/paper.pdf"][0];
  assert.match(first.pdf.fingerprint, /^[0-9a-f]{40}$/);
  assert.equal(first.pdf.text, "Your abstract here.");
  assert.equal(first.pdf.regions[0].page, 1);
  assert.deepEqual(Object.keys(first.pdf).sort(), [
    "fingerprint",
    "regions",
    "text",
  ]);
  const drawer = main.locator('[data-chat-drawer-panel="true"]');
  const excerpt = drawer.locator('[data-selection-chip="true"]');
  const commentBadge = drawer.locator('[data-comment-chip="true"]');
  const scroller = main.getByTestId("pdf-scroll-container");
  const startHandle = main.getByRole("button", {
    name: "Resize comment start",
  });
  await expect(startHandle).toBeVisible();
  await startHandle.hover();
  const handleBox = await startHandle.boundingBox();
  const destination = await main
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first()
    .evaluate((text) => {
      const x = text.getStartPositionOfChar(5).x;
      const glyph = text.getExtentOfChar(5);
      const point = new DOMPoint(x, glyph.y + glyph.height / 2).matrixTransform(
        text.getScreenCTM(),
      );
      return { x: point.x, y: point.y };
    });
  await main.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await main.mouse.down();
  await main.mouse.move(destination.x, destination.y, { steps: 8 });
  await expect
    .poll(async () => (await startHandle.boundingBox()).x)
    .toBeGreaterThan(handleBox.x + 2);
  await main.mouse.up();
  const readFirst = async () => (await stored(main)).files["a/paper.pdf"][0];
  await expect
    .poll(async () => (await readFirst()).pdf.text)
    .toBe("abstract here.");
  const resized = await readFirst();
  assert.equal(resized.id, first.id);
  assert.equal(resized.text, first.text);
  await scroller.press("ControlOrMeta+z");
  await expect.poll(async () => (await readFirst()).pdf).toEqual(first.pdf);
  await scroller.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await readFirst()).pdf).toEqual(resized.pdf);
  first = resized;
  await scroller.click({ position: { x: 10, y: 10 } });
  await selectPdfText(main);
  await expect(excerpt).toContainText("a/paper.pdf");
  await expect(commentBadge).toContainText("a/paper.pdf");
  await main.screenshot({
    path: path.join(artifacts, "native-pdf-selection-badges.png"),
  });
  await scroller.press("Escape");
  await expect(excerpt).toHaveCount(0);
  await expect(commentBadge).toHaveCount(0);
  const opened = app.waitForEvent("window");
  await main.evaluate(async () => {
    const { openPanelWindow } = await import(
      "/src/renderer/lib/panel-windows.ts"
    );
    openPanelWindow("editor", "duet");
  });
  const child = await ready(await opened);
  await expect(child.locator(".mupdf-text-layer").first()).toBeVisible();
  const childCard = await addComment(child, "Native pop-out annotation");
  await expect
    .poll(async () => (await stored(main)).files["a/paper.pdf"]?.length)
    .toBe(2);
  for (const action of ["Resolve", "Delete"]) {
    if (action === "Delete") {
      const summary = child.getByRole("button", { name: /Show comments:/ });
      if (await summary.isVisible()) await summary.click();
      await child.getByRole("button", { name: /Go to comment/ }).click();
    }
    await childCard
      .getByRole("button", { name: `${action} comment`, exact: true })
      .click();
    await childCard
      .getByRole("button", {
        name: `Confirm ${action.toLowerCase()} comment`,
        exact: true,
      })
      .click();
    await expect
      .poll(
        async () =>
          (await stored(main)).files["a/paper.pdf"].filter((c) => !c.resolved)
            .length,
      )
      .toBe(1);
    await child.getByTestId("pdf-scroll-container").focus();
    await child.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(
        async () =>
          (await stored(main)).files["a/paper.pdf"].filter((c) => !c.resolved)
            .length,
      )
      .toBe(2);
  }
  await main.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.getState().setActiveFile("b/paper.pdf");
  });
  await expect(main.locator("[data-pdf-comment-highlight]")).toHaveCount(0);
  await expect(
    main.getByText("Native PDF comment", { exact: true }),
  ).toHaveCount(0);
  await selectPdfText(main);
  await expect(excerpt).toContainText("b/paper.pdf");
  await expect(commentBadge).toHaveCount(0);
  await addComment(main, "Other same-named PDF");
  await expect
    .poll(async () => (await stored(main)).files["b/paper.pdf"]?.[0]?.text)
    .toBe("Other same-named PDF");
  assert.deepEqual(await fs.readFile(path.join(project, "a/paper.pdf")), bytes);
  await child.screenshot({
    path: path.join(artifacts, "native-pdf-comment.png"),
  });
  await app.close();
  app = null;
  main = await launch();
  let snapshot = await stored(main);
  assert.equal(snapshot.files["a/paper.pdf"].length, 2);
  assert.equal(snapshot.files["b/paper.pdf"].length, 1);
  assert.deepEqual(snapshot.files["a/paper.pdf"][0].pdf, first.pdf);
  const summary = main.getByRole("button", {
    name: "Show comments: 2 human, 0 agent",
    exact: true,
  });
  const navigate = main.getByRole("button", { name: /Go to comment/ });
  await expect(summary.or(navigate)).toBeVisible();
  if (await summary.isVisible()) await summary.click();
  await main.getByRole("button", { name: /Go to comment/ }).click();
  await expect(
    main.getByRole("dialog", { name: "PDF comment", exact: true }),
  ).toBeVisible();
  await main.screenshot({
    path: path.join(artifacts, "native-pdf-comment-restarted.png"),
  });
  const replacement = await fs.readFile(
    path.join(desktopRoot, "public/examples/blank/main.pdf"),
  );
  assert.notDeepEqual(bytes, replacement);
  await fs.writeFile(path.join(project, "a/paper.pdf"), replacement);
  await expect
    .poll(async () =>
      Object.keys((await stored(main)).disconnected ?? {}).includes(
        "a/paper.pdf",
      ),
    )
    .toBe(true);
  snapshot = await stored(main);
  assert.equal(snapshot.files["a/paper.pdf"], undefined);
  assert.equal(snapshot.disconnected["a/paper.pdf"].length, 2);
  assert.equal(snapshot.files["b/paper.pdf"].length, 1);
  await expect(
    main.getByRole("dialog", { name: "PDF comment", exact: true }),
  ).toHaveCount(0);
  // Relinking. An identical copy elsewhere in the project is found by content.
  const manager = main.getByRole("dialog", {
    name: "Manage comments",
    exact: true,
  });
  const openManager = async () => {
    await main.evaluate(async () => {
      const { OPEN_COMMENT_MANAGER_EVENT } = await import(
        "/src/renderer/lib/workspace-events.ts"
      );
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      window.dispatchEvent(
        new CustomEvent(OPEN_COMMENT_MANAGER_EVENT, {
          detail: { projectRoot: useDocumentStore.getState().projectRoot },
        }),
      );
    });
    await expect(manager).toBeVisible();
  };
  const selectGroup = (file) =>
    manager
      .getByRole("checkbox", {
        name: `Select disconnected file ${file}`,
        exact: true,
      })
      .check();
  const before = snapshot.disconnected["a/paper.pdf"];
  await fs.mkdir(path.join(project, "c"));
  await fs.writeFile(path.join(project, "c/moved.pdf"), bytes);
  await openManager();
  const autoRelink = async (message) => {
    await selectGroup("a/paper.pdf");
    await manager.getByText("Auto-relink selected", { exact: true }).click();
    await manager
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await expect(manager.getByText(message)).toBeVisible();
  };
  // b/paper.pdf has the same bytes, so the match is not unique yet.
  await autoRelink("0 comments relinked. 2 remain disconnected.");
  await fs.rm(path.join(project, "b/paper.pdf"));
  await expect
    .poll(
      async () => (await stored(main)).disconnected?.["b/paper.pdf"]?.length,
    )
    .toBe(1);
  await autoRelink("2 comments relinked. 0 remain disconnected.");
  snapshot = await stored(main);
  assert.deepEqual(snapshot.files["c/moved.pdf"], before);
  assert.equal(snapshot.disconnected["a/paper.pdf"], undefined);

  // A revised file has other bytes: comments return where their text is found.
  const revised = Buffer.concat([bytes, Buffer.from("\n% revised\n")]);
  await fs.writeFile(path.join(project, "c/moved.pdf"), revised);
  await expect
    .poll(
      async () => (await stored(main)).disconnected?.["c/moved.pdf"]?.length,
    )
    .toBe(2);
  await selectGroup("c/moved.pdf");
  await manager
    .getByText("Reconnect comments to file", { exact: true })
    .click();
  const target = manager.getByRole("combobox", {
    name: "Target file",
    exact: true,
  });
  await target.fill("c/moved.pdf");
  await main.getByRole("option", { name: "c/moved.pdf", exact: true }).click();
  await expect(manager.getByText("Ready to relink.")).toBeVisible();
  await main.screenshot({
    path: path.join(artifacts, "native-pdf-comment-relink.png"),
  });
  await manager.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    manager.getByText("Comments linked to c/moved.pdf."),
  ).toBeVisible();
  snapshot = await stored(main);
  assert.equal(snapshot.disconnected["c/moved.pdf"], undefined);
  const relinked = snapshot.files["c/moved.pdf"];
  assert.deepEqual(
    relinked.map((comment) => [comment.id, comment.text, comment.pdf.text]),
    before.map((comment) => [comment.id, comment.text, comment.pdf.text]),
  );
  for (const [index, comment] of relinked.entries()) {
    assert.notEqual(comment.pdf.fingerprint, first.pdf.fingerprint);
    assert.equal(comment.pdf.regions[0].page, 1);
    assert.ok(
      Math.abs(comment.pdf.regions[0].x - before[index].pdf.regions[0].x) < 1,
    );
  }
  // A text file is refused, and the PDF shows its comments again.
  await fs.writeFile(path.join(project, "notes.txt"), "Plain text\n");
  await assert.rejects(
    main.evaluate(
      async ({ projectRoot, ids }) => {
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        return invoke("manage_comment_files", {
          projectRoot,
          selection: [{ path: "c/moved.pdf", disconnected: false, ids }],
          author: "all",
          action: "relink",
          target: "notes.txt",
          preview: true,
        });
      },
      { projectRoot: project, ids: relinked.map((comment) => comment.id) },
    ),
    /PDF comments can only be reconnected to a PDF/,
  );
  await manager.getByRole("button", { name: "Close", exact: true }).click();
  await main.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().refreshFiles?.();
    useDocumentStore.getState().setActiveFile("c/moved.pdf");
  });
  await expect(
    main.locator("[data-pdf-comment-highlight]").first(),
  ).toBeVisible();
  await main.screenshot({
    path: path.join(artifacts, "native-pdf-comment-relinked.png"),
  });
  const passage = "Related Work";
  const toolbar = () => main.locator("[data-selection-toolbar]");
  const popoutOpening = app.waitForEvent("window");
  await main.evaluate(async () => {
    const { openPanelWindow } = await import(
      "/src/renderer/lib/panel-windows.ts"
    );
    openPanelWindow("editor", "duet");
  });
  const popout = await ready(await popoutOpening);
  await selectPdfText(popout, passage);
  const popoutToolbar = popout.locator("[data-selection-toolbar]");
  await popoutToolbar.hover();
  await popoutToolbar
    .getByRole("button", { name: "Set color to Graphite" })
    .click();
  const savedHighlight = async () =>
    (await stored(main)).files["c/moved.pdf"]?.find((comment) =>
      comment.pdf?.text.includes(passage),
    );
  await expect.poll(savedHighlight).toBeUndefined();
  await popoutToolbar
    .getByRole("button", { name: "Highlight", exact: true })
    .click();
  await expect.poll(savedHighlight).toMatchObject({ color: "gray", text: "" });
  await selectPdfText(main);
  await expect(
    toolbar().getByRole("button", { name: "Set color to Graphite" }),
  ).toHaveAttribute("aria-pressed", "true");
  const identity = await savedHighlight();
  await app.close();
  app = null;
  main = await launch("c/moved.pdf");
  await expect.poll(savedHighlight).toMatchObject({
    id: identity.id,
    number: identity.number,
    color: "gray",
    text: "",
  });
  await selectPdfText(main, "Your abstract here.");
  await expect(
    toolbar().getByRole("button", { name: "Set color to Graphite" }),
  ).toHaveAttribute("aria-pressed", "true");
  await main.keyboard.press("Escape");
  await main
    .locator(".mupdf-text-layer text")
    .filter({ hasText: passage })
    .first()
    .click();
  await toolbar().screenshot({
    path: path.join(artifacts, "native-highlight-toolbar.png"),
  });
  await toolbar()
    .getByRole("button", { name: "Remove highlight", exact: true })
    .click();
  assert.equal((await savedHighlight()).id, identity.id);
  await toolbar()
    .getByRole("button", { name: "Confirm delete highlight", exact: true })
    .click();
  await expect.poll(savedHighlight).toBeUndefined();
  await main.getByTestId("pdf-scroll-container").focus();
  await main.keyboard.press("ControlOrMeta+z");
  await expect.poll(savedHighlight).toMatchObject(identity);
  await main
    .locator(".mupdf-text-layer text")
    .filter({ hasText: passage })
    .first()
    .click();
  await toolbar()
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  const editor = main.getByRole("dialog", { name: "PDF comment", exact: true });
  await editor
    .getByRole("textbox", { name: "Comment text" })
    .fill("Review this passage");
  await editor
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect.poll(savedHighlight).toMatchObject({
    id: identity.id,
    number: identity.number,
    color: "gray",
    text: "Review this passage",
  });
  assert.deepEqual(errors, []);
  console.log(
    "Native PDF comments and colored highlights, resize undo/redo, selection badges, same-name isolation, immutable files, pop-out sharing, restart persistence, replacement disconnection, and relinking passed.",
  );
} catch (error) {
  if (app)
    for (const [index, page] of app.windows().entries())
      await page
        .screenshot({ path: path.join(artifacts, `failure-${index}.png`) })
        .catch(() => {});
  console.error({ profile, project, errors });
  throw error;
} finally {
  if (app) await app.close();
  await vite.close();
}
