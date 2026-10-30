import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const original = "The accuracy is 80%.\n";
const edited = "The accuracy is 82%.\n";
const reviewed = "The accuracy is 95%.\n";
let root: string;
let failWrites = false;
let commands: string[];
let checkpoints: Array<{ message: string; content: string }>;
let writeGate: Promise<void> | null = null;
let releaseWrite: (() => void) | undefined;
async function git(...args: string[]) {
  return (
    await exec("git", ["-C", root, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    })
  ).stdout.trim();
}

async function openHarness(page: Page, initialText = "80%") {
  await page.exposeFunction(
    "__gitBufferInvoke",
    async (command: string, args: Record<string, unknown>) => {
      const path = String(args.path ?? "");
      if (command === "save_file_if_unchanged") {
        const file = join(root, String(args.filePath));
        const current = await readFile(file, "utf8");
        if (current !== args.expected) return { written: false, current };
        commands.push("save");
        if (failWrites) throw new Error("Test disk is read-only");
        if (writeGate) await writeGate;
        await writeFile(file, String(args.content));
        return { written: true, current: args.content };
      }
      if (command === "history_snapshot") {
        checkpoints.push({
          message: String(args.message),
          content: await readFile(join(root, "main.tex"), "utf8"),
        });
        return null;
      }
      if (command === "plugin:path|join")
        return (args.paths as string[]).join("/");
      if (command === "plugin:fs|exists") return false;
      if (command === "plugin:fs|read_dir") {
        if (path !== root) return [];
        return (await readdir(root, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        }));
      }
      if (command === "plugin:fs|read_text_file") {
        if (!path.startsWith(`${root}/`)) return [];
        return [...(await readFile(path))];
      }
      if (command === "plugin:fs|write_text_file") {
        if (!path.startsWith(`${root}/`))
          throw new Error("Outside test repository");
        commands.push("save");
        if (failWrites) throw new Error("Test disk is read-only");
        if (writeGate) await writeGate;
        await writeFile(path, String(args.content));
        return null;
      }
      if (command === "git_panel_status") {
        const dirty = Boolean(await git("status", "--porcelain"));
        return {
          repo_found: true,
          branch: await git("branch", "--show-current"),
          upstream_branch: null,
          ahead: 0,
          behind: 0,
          staged: 0,
          unstaged: dirty ? 1 : 0,
          untracked: 0,
          conflicted: 0,
          operation: null,
          can_push: false,
        };
      }
      if (command === "git_panel_branches") {
        const current = await git("branch", "--show-current");
        return ["draft", "reviewed"].map((name) => ({
          name,
          is_current: name === current,
        }));
      }
      if (command === "git_panel_changed_files") {
        return (await git("status", "--porcelain"))
          ? [
              {
                path: "main.tex",
                staged: false,
                unstaged: true,
                untracked: false,
                conflicted: false,
              },
            ]
          : [];
      }
      if (command === "git_panel_pull_status")
        return { can_pull: false, behind: 0, behind_commits: [] };
      if (command === "git_panel_checkout_branch") {
        commands.push("checkout");
        await git("checkout", String(args.branch));
      } else if (command === "git_panel_commit_selected") {
        commands.push("commit");
        const paths = args.selectedFiles as string[];
        await git("add", "--", ...paths);
        await git("commit", "-m", String(args.message), "--", ...paths);
      } else if (command === "git_panel_reset_selected") {
        commands.push("reset");
        await git(
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--",
          ...(args.selectedFiles as string[]),
        );
      } else return [];
      return { success: true, message: "Git operation completed" };
    },
  );
  await page.addInitScript((projectRoot) => {
    window.__gitBufferRoot = projectRoot;
  }, root);
  await page.goto("/?debug=git-buffers");
  await expect(page.locator(".cm-content").first()).toContainText(initialText);
  await expect(page.locator(".cm-content").first()).toBeInViewport();
}

async function edit(page: Page) {
  const editor = page.locator(".cm-content").first();
  await editor.fill(edited);
  await expect(editor).toContainText("82%");
}

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catalex-git-buffers-"));
  failWrites = false;
  writeGate = null;
  releaseWrite = undefined;
  commands = [];
  checkpoints = [];
  await git("init", "-b", "draft");
  await git("config", "user.name", "Git buffer test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.hooksPath", "/dev/null");
  await writeFile(join(root, "main.tex"), original);
  await git("add", "main.tex");
  await git("commit", "-m", "Draft");
  await git("checkout", "-b", "reviewed");
  await writeFile(join(root, "main.tex"), reviewed);
  await git("commit", "-am", "Reviewed");
  await git("checkout", "draft");
});
test.afterEach(async ({ page }) => {
  releaseWrite?.();
  await page.close();
  await rm(root, { recursive: true, force: true });
});

test("switching branches immediately after editing saves first and lets Git protect the edit", async ({
  page,
}) => {
  await openHarness(page);
  // Freeze autosave while entering the branch-switch flow.
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await edit(page);
  await page.getByRole("button", { name: "More git actions" }).click();
  await page.getByRole("menuitem", { name: "Git history…" }).click();
  await page.getByLabel("Branch", { exact: true }).click();
  await page.getByRole("option", { name: "reviewed", exact: true }).click();
  await expect.poll(() => commands.includes("checkout")).toBe(true);
  await page.clock.runFor(2100);
  await expect
    .poll(async () => ({
      branch: await git("branch", "--show-current"),
      content: await readFile(join(root, "main.tex"), "utf8"),
      operations: commands,
    }))
    .toEqual({
      branch: "draft",
      content: edited,
      operations: ["save", "checkout"],
    });
  await expect(page.locator(".cm-content").first()).toContainText("82%");
  await page.clock.resume();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "test-results/git-buffer-checkout.png",
    animations: "disabled",
  });
});

test("a clean branch switch reloads the reviewed content", async ({ page }) => {
  await openHarness(page);
  await page.getByRole("button", { name: "More git actions" }).click();
  await page.getByRole("menuitem", { name: "Git history…" }).click();
  await page.getByLabel("Branch", { exact: true }).click();
  await page.getByRole("option", { name: "reviewed", exact: true }).click();
  await expect(page.locator(".cm-content").first()).toContainText("95%");
  expect(await git("branch", "--show-current")).toBe("reviewed");
  expect(commands).toEqual(["checkout"]);
});

test("a failed save cancels checkout and leaves the edit available", async ({
  page,
}) => {
  await openHarness(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await edit(page);
  failWrites = true;
  await page.getByRole("button", { name: "More git actions" }).click();
  await page.getByRole("menuitem", { name: "Git history…" }).click();
  await page.getByLabel("Branch", { exact: true }).click();
  await page.getByRole("option", { name: "reviewed", exact: true }).click();
  await expect.poll(() => commands.includes("save")).toBe(true);
  await expect(page.getByLabel("Branch", { exact: true })).toBeEnabled();
  await page.clock.runFor(50);
  await expect(
    page.getByText(/Could not save main.tex. Git operation canceled./),
  ).toBeVisible();
  expect(commands).toEqual(["save"]);
  expect(await git("branch", "--show-current")).toBe("draft");
  expect(await readFile(join(root, "main.tex"), "utf8")).toBe(original);
  await page
    .getByRole("dialog", { name: "Git history" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator(".cm-content").first()).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await expect(page.locator(".cm-content").first()).toContainText("82%");
  await page.clock.resume();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "test-results/git-buffer-save-error.png",
    animations: "disabled",
  });
});

for (const failed of [false, true]) {
  test(`commit ${failed ? "stops on a failed save" : "includes the newest editor content"}`, async ({
    page,
  }) => {
    await writeFile(join(root, "main.tex"), "The accuracy is 81%.\n");
    await openHarness(page, "81%");
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await edit(page);
    failWrites = failed;
    await page.getByRole("button", { name: "Commit", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Commit your changes" })
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    if (failed) {
      await expect.poll(() => commands.includes("save")).toBe(true);
      await expect(
        page
          .getByRole("dialog", { name: "Commit your changes" })
          .getByRole("button", { name: "Continue", exact: true }),
      ).toBeEnabled();
      await page.clock.runFor(50);
      await expect(
        page.getByText(/Could not save main.tex. Git operation canceled./),
      ).toBeVisible();
      expect(commands).toEqual(["save"]);
      expect(await git("show", "HEAD:main.tex")).toBe(original.trim());
    } else {
      await expect.poll(() => git("show", "HEAD:main.tex")).toBe(edited.trim());
      expect(commands).toEqual(["save", "commit"]);
      expect(await git("status", "--porcelain")).toBe("");
    }
  });
}

for (const inFlight of [false, true]) {
  test(`reset ${inFlight ? "waits for an in-flight autosave" : "saves pending edits for its safety checkpoint"} and keeps restored content`, async ({
    page,
  }) => {
    await writeFile(join(root, "main.tex"), "The accuracy is 81%.\n");
    await openHarness(page, "81%");
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await edit(page);
    if (inFlight) {
      writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      await page.clock.runFor(2100);
      await expect.poll(() => commands).toEqual(["save"]);
    }
    await page.getByRole("button", { name: "More git actions" }).click();
    await page.getByRole("menuitem", { name: "Reset", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Reset selected files" })
      .getByRole("button", { name: "Reset", exact: true })
      .click();
    if (inFlight) {
      await expect(page.locator(".cm-content").first()).toHaveAttribute(
        "contenteditable",
        "false",
      );
      expect(commands).toEqual(["save"]);
      releaseWrite?.();
    }
    await expect(page.locator(".cm-content").first()).toContainText("80%");
    await page.clock.runFor(2100);
    expect(await readFile(join(root, "main.tex"), "utf8")).toBe(original);
    expect(await git("status", "--porcelain")).toBe("");
    expect(commands).toEqual(["save", "reset"]);
    expect(checkpoints).toEqual(
      expect.arrayContaining([
        { message: "[git] Before reset", content: edited },
        { message: "[git] After reset", content: original },
      ]),
    );
    await expect(page.locator(".cm-content").first()).toHaveAttribute(
      "contenteditable",
      "true",
    );
    await page.clock.resume();
    await page.waitForTimeout(400);
    await page.screenshot({
      animations: "disabled",
      path: `test-results/git-buffer-reset-${inFlight ? "in-flight" : "pending"}.png`,
    });
  });
}

for (const operation of ["checkout", "merge"] as const) {
  test(`real Git ${operation} updates both comment origins from the saved source`, async ({
    page,
  }) => {
    const prefix = "Introduction.\n";
    await git("checkout", "reviewed");
    await writeFile(join(root, "main.tex"), prefix + original);
    await git("commit", "-am", "Insert introduction");
    await git("checkout", "draft");
    await openHarness(page);
    await page.evaluate(
      async ({ root, original }) => {
        const key = `catalex-harness-comments:${root}`;
        const comments = [
          {
            id: "human",
            number: 1,
            from: 4,
            to: 12,
            line: 1,
            text: "Human note",
            anchorRevision: "before-git",
          },
          {
            id: "agent",
            number: 1,
            from: 4,
            to: 12,
            line: 1,
            text: "Agent note",
            anchorRevision: "before-git",
            origin: { provider: "codex", sessionId: "test" },
          },
        ];
        localStorage.setItem(key, JSON.stringify({ "main.tex": comments }));
        localStorage.setItem(
          `catalex-harness-comment-sources:${root}`,
          JSON.stringify({ "before-git": original }),
        );
        const modulePath =
          "/src/renderer/components/workspace/editor/inline-comment-storage.ts";
        const { synchronizeProjectCommentAnchors } = await import(modulePath);
        await synchronizeProjectCommentAnchors(root);
      },
      { root, original },
    );
    await page.exposeFunction("__applyTestGit", () =>
      operation === "checkout"
        ? git("checkout", "reviewed")
        : git("merge", "--ff-only", "reviewed"),
    );
    await page.evaluate(async (root) => {
      const modulePath = "/src/renderer/stores/document-store.ts";
      const { useDocumentStore } = await import(modulePath);
      await useDocumentStore
        .getState()
        .runGitOperation(root, {}, () =>
          (
            window as unknown as { __applyTestGit: () => Promise<string> }
          ).__applyTestGit(),
        );
    }, root);
    const comments = await page.evaluate(
      (root) =>
        JSON.parse(localStorage.getItem(`catalex-harness-comments:${root}`)!)[
          "main.tex"
        ],
      root,
    );
    expect(comments).toHaveLength(2);
    for (const comment of comments) {
      expect(comment).toMatchObject({
        from: prefix.length + 4,
        to: prefix.length + 12,
        line: 2,
      });
      expect(comment.positionReset).toBeUndefined();
    }
    expect(comments.map((comment: { text: string }) => comment.text)).toEqual([
      "Human note",
      "Agent note",
    ]);
    expect(await readFile(join(root, "main.tex"), "utf8")).toBe(
      prefix + original,
    );
  });
}
