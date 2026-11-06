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
  configFile: path.join(desktopRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
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
async function launch() {
  app = await electron.launch({ args: [desktopRoot], env });
  const page = await ready(await app.firstWindow());
  await page.evaluate(async (project) => {
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
    useDocumentStore.getState().setActiveFile("a/paper.pdf");
  }, project);
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
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
async function addComment(page, text) {
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  await line.scrollIntoViewIfNeeded();
  await line.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
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
  await addComment(main, "Native PDF comment");
  await expect
    .poll(async () => (await stored(main)).files["a/paper.pdf"]?.[0]?.text)
    .toBe("Native PDF comment");
  const first = (await stored(main)).files["a/paper.pdf"][0];
  assert.match(first.pdf.fingerprint, /^[0-9a-f]{40}$/);
  assert.equal(first.pdf.text, "Your abstract here.");
  assert.equal(first.pdf.regions[0].page, 1);
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
  assert.deepEqual(errors, []);
  console.log(
    "Native PDF comments, same-name isolation, immutable files, pop-out sharing, restart persistence and replacement disconnection passed.",
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
