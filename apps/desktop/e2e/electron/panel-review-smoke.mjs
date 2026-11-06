import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-panel-review-"),
);
const project = path.join(profile, "Review project");
await fs.mkdir(project);
for (const name of ["first", "second", "removed"])
  await fs.writeFile(path.join(project, `${name}.md`), `Original ${name}.\n`);
const git = (...args) =>
  execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
git("init", "-b", "main");
git("config", "user.email", "test@example.com");
git("config", "user.name", "Panel review test");
git("add", ".");
git("commit", "-m", "Fixture source");
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/electron/panel-review",
);
await fs.mkdir(artifacts, { recursive: true });
const vite = await createServer({
  root: desktopRoot,
  configFile: path.join(desktopRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
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
try {
  app = await electron.launch({ args: [desktopRoot], env });
  const main = await ready(await app.firstWindow());
  await main.evaluate(async (root) => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({ defaultAutoCompile: false });
    const { useDocumentStore: doc } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await doc.getState().openProject(root);
    doc.getState().setActiveFile("first.md");
  }, project);
  await expect(main.locator(".cm-content")).toContainText("Original first.");
  const open = async (file) => {
    const opened = app.waitForEvent("window");
    await main.evaluate(async (id) => {
      const { useDocumentStore: doc } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const { openPanelWindow } = await import(
        "/src/renderer/lib/panel-windows.ts"
      );
      doc.getState().setActiveFile(id);
      openPanelWindow("editor", "duet");
    }, file);
    return ready(await opened);
  };
  const first = await open("first.md");
  const second = await open("second.md");
  const removed = await open("removed.md");
  const session = await main.evaluate(async (root) => {
    const { useDocumentStore: doc } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { useAgentChatStore: chat } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    await doc.getState().saveAllFiles({ requireClean: true });
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return invoke("prepare_agent_workspace", {
      projectRoot: root,
      tabId: chat.getState().activeTabId,
      mode: "ask",
      dirtyBuffers: [],
    });
  }, project);
  await fs.writeFile(
    path.join(session.candidateRoot, "first.md"),
    "Proposed first.\n",
  );
  await fs.writeFile(
    path.join(session.candidateRoot, "second.md"),
    "Proposed second.\n",
  );
  await fs.unlink(path.join(session.candidateRoot, "removed.md"));
  await main.evaluate(
    async ({ root, sessionId }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      const result = await invoke("reconcile_agent_workspace", {
        projectRoot: root,
        sessionId,
        outcome: "success",
      });
      const { useAgentChatStore: chat } = await import(
        "/src/renderer/stores/agent-chat-store.ts"
      );
      chat.getState()._setAgentWorkspace(result.session.tabId, result.session);
      const { useAgentReviewQueueStore: reviews } = await import(
        "/src/renderer/stores/agent-review-queue-store.ts"
      );
      await reviews.getState().enqueue(result.session);
      const { useDocumentStore: doc } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      doc.getState().setActiveFile("first.md");
    },
    { root: project, sessionId: session.sessionId },
  );
  for (const child of [first, second, removed]) {
    assert.equal(child.isClosed(), false);
    await expect(child.locator("[data-proposed-changes-panel]")).toBeVisible();
  }
  await second
    .locator("[data-proposed-changes-panel]")
    .getByRole("button", { name: "Accept All", exact: true })
    .click();
  await expect
    .poll(() => fs.readFile(path.join(project, "second.md"), "utf8"))
    .toBe("Proposed second.\n");
  await expect(first.locator("[data-proposed-changes-panel]")).toBeVisible();
  await main
    .locator("[data-proposed-changes-panel]")
    .getByRole("button", { name: "Accept All", exact: true })
    .click();
  await expect
    .poll(() => fs.readFile(path.join(project, "first.md"), "utf8"))
    .toBe("Proposed first.\n");
  await expect(first.locator("[data-proposed-changes-panel]")).toHaveCount(0);
  await expect(first.locator(".cm-content")).toContainText("Proposed first.");
  const closed = removed.waitForEvent("close");
  await removed
    .locator("[data-proposed-changes-panel]")
    .getByRole("button", { name: "Accept All", exact: true })
    .click();
  await closed;
  assert.equal(
    await fs.stat(path.join(project, "removed.md")).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(first.isClosed(), false);
  assert.equal(second.isClosed(), false);
  await expect
    .poll(() =>
      main.evaluate(async () => {
        const { useDocumentStore: doc } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        const { useProposedChangesStore: proposals } = await import(
          "/src/renderer/stores/proposed-changes-store.ts"
        );
        return (
          !doc.getState().agentWorkspaceRoot &&
          !doc.getState().isApplyingAgentDraft &&
          !doc.getState().isAgentWorkspaceReadOnly &&
          !proposals.getState().workspaceReview?.isApplying
        );
      }),
    )
    .toBe(true);
  await expect(first.locator(".cm-content")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await first.locator(".cm-content").focus();
  await first.keyboard.press("ControlOrMeta+Home");
  await first.keyboard.insertText("Edited after review. ");
  await expect
    .poll(() =>
      main.evaluate(async () => {
        const { useDocumentStore: doc } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        return doc.getState().files.find((file) => file.id === "first.md")
          ?.content;
      }),
    )
    .toBe("Edited after review. Proposed first.\n");
  await main.evaluate(async () => {
    const { useDocumentStore: doc } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await doc.getState().saveAllFiles({ requireClean: true });
  });
  await expect
    .poll(() => fs.readFile(path.join(project, "first.md"), "utf8"))
    .toBe("Edited after review. Proposed first.\n");
  await first.screenshot({ path: path.join(artifacts, "accepted-popout.png") });
  assert.deepEqual(errors, []);
  console.log(
    "Native pop-outs survived draft/source transitions; independent decisions shared one review; accepted deletion closed only its view; editing and saving resumed.",
  );
} finally {
  if (app) await app.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
