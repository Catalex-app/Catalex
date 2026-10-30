import { writeCommentFixture } from "./comment-fixture.mjs";
import { checkManagerMemory } from "./comment-manager-memory.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { createServer } from "vite";

const reviewWorkload = process.env.CATALEX_REVIEW_WORKLOAD === "1";
const checkMemory = process.env.CATALEX_CHECK_MANAGER_MEMORY === "1";
const checkAutosave = process.env.CATALEX_CHECK_AUTOSAVE === "1";
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-comment-performance-"),
);
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let app;
try {
  await vite.listen();
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  const counts = (process.env.CATALEX_PERF_COMMENT_COUNTS ?? "100,500,1000")
    .split(",")
    .map(Number);
  assert.ok(counts.every((n) => Number.isInteger(n) && n > 0 && n <= 10000));
  for (const count of counts) {
    const projectRoot = path.join(profile, `project-${count}`);
    await fs.mkdir(projectRoot);
    const lines = Math.max(4000, count * 4);
    const source =
      "A sentence with words for testing comment performance.\n".repeat(lines);
    const revision = createHash("sha1").update(source).digest("hex");
    const comments = Array.from({ length: count }, (_, index) => ({
      id: `c-${index}`,
      number: index + 1,
      from: index * (source.length / lines) * 4,
      to: index * (source.length / lines) * 4 + 10,
      line: index * 4 + 1,
      text: `Feedback ${index}`,
      anchorRevision: revision,
      ...((reviewWorkload || checkMemory) && index % 2
        ? {
            origin: {
              provider: "codex",
              sessionId: "performance-fixture",
              model: "fixture",
              thinkingEffort: "medium",
            },
          }
        : {}),
    }));
    await fs.writeFile(path.join(projectRoot, "main.tex"), source);
    await page.evaluate(async (projectRoot) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      await invoke("read_project_comments_anchored", { projectRoot });
    }, projectRoot);
    const registry = JSON.parse(
      await fs.readFile(
        path.join(profile, "data/project-registry.json"),
        "utf8",
      ),
    );
    const canonical = await fs.realpath(projectRoot);
    const id = registry.projects.find((entry) =>
      entry.paths.includes(canonical),
    ).id;
    const storage = path.join(profile, "data/projects", id, "comments");
    await fs.mkdir(storage, { recursive: true });
    await writeCommentFixture(
      path.join(storage, "human.json"),
      JSON.stringify({
        version: 1,
        counter: count,
        files: { "main.tex": comments.filter((comment) => !comment.origin) },
        sources: { [revision]: source },
        revisions: { "main.tex": [revision] },
      }),
    );
    if (reviewWorkload || checkMemory) {
      await writeCommentFixture(
        path.join(storage, "agent.json"),
        JSON.stringify({
          version: 1,
          counter: count,
          files: { "main.tex": comments.filter((comment) => comment.origin) },
          sources: { [revision]: source },
          revisions: { "main.tex": [revision] },
        }),
      );
    }
    const result = await page.evaluate(
      async ({ projectRoot, source, comments }) => {
        const { EditorState } = await import("/@id/@codemirror/state");
        const { mapInlineCommentsThroughChanges } = await import(
          "/src/renderer/components/workspace/editor/inline-comments.ts"
        );
        const { saveProjectInlineComments } = await import(
          "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
        );
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        const state = EditorState.create({ doc: source });
        const update = state.update({
          changes: { from: 0, insert: "Intro\n" },
        });
        const durations = [];
        let mapped;
        for (let repeat = 0; repeat < 15; repeat++) {
          const start = performance.now();
          mapped = mapInlineCommentsThroughChanges(
            comments,
            update.changes,
            update.state,
            state,
          );
          durations.push(performance.now() - start);
        }
        const start = performance.now();
        await saveProjectInlineComments(
          projectRoot,
          { "main.tex": comments },
          { "main.tex": mapped },
          { "main.tex": update.state.doc.toString() },
        );
        const saveMs = performance.now() - start;
        const saved = await invoke("read_project_comments_anchored", {
          projectRoot,
        });
        return {
          mapMedianMs: durations.sort((a, b) => a - b)[7],
          saveMs,
          saved: saved.files["main.tex"],
        };
      },
      { projectRoot, source, comments },
    );
    assert.equal(result.saved.length, count);
    const originals = new Map(comments.map((comment) => [comment.id, comment]));
    for (const comment of result.saved) {
      const original = originals.get(comment.id);
      assert.equal(comment.from, original.from + 6);
      assert.equal(comment.to, original.to + 6);
      assert.equal(comment.line, original.line + 1);
      assert.equal(comment.text, original.text);
    }
    console.log(
      JSON.stringify({
        count,
        bytes: Buffer.byteLength(source),
        mapMedianMs: result.mapMedianMs,
        saveMs: result.saveMs,
      }),
    );
    if (
      process.env.CATALEX_ALL_COMMENT_COUNTS === "1" ||
      count === Math.max(...counts)
    ) {
      await fs.writeFile(
        path.join(projectRoot, "main.tex"),
        `Intro\n${source}`,
      );
      await page.evaluate(async (projectRoot) => {
        const { useOnboardingStore } = await import(
          "/src/renderer/stores/onboarding-store.ts"
        );
        useOnboardingStore.getState().finish();
        const { useDocumentStore } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        await useDocumentStore.getState().openProject(projectRoot);
        useDocumentStore.getState().setActiveFile("main.tex");
        await useDocumentStore.getState().loadFileContent("main.tex");
      }, projectRoot);
      await page.waitForSelector(
        '.cm-inlineCommentCard[data-inline-comment-id="c-0"]',
      );
      const profiler =
        process.env.CATALEX_PROFILE_COMMENTS === "1"
          ? await page.context().newCDPSession(page)
          : undefined;
      await profiler?.send("Profiler.enable");
      await profiler?.send("Profiler.start");
      const typing = await page.evaluate(
        async ({ projectRoot, checkAutosave }) => {
          const { EditorView } = await import("/@id/@codemirror/view");
          const { flushProjectCommentWrites } = await import(
            "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
          );
          const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
          const view = EditorView.findFromDOM(
            document.querySelector(".cm-content"),
          );
          const times = [];
          const frames = [];
          for (let index = 0; index < 20; index++) {
            const start = performance.now();
            view.dispatch({ changes: { from: 0, insert: "x" } });
            times.push(performance.now() - start);
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            frames.push(performance.now() - start);
            if (checkAutosave)
              await new Promise((resolve) => setTimeout(resolve, 350));
          }
          const start = performance.now();
          await flushProjectCommentWrites(projectRoot);
          const drainMs = performance.now() - start;
          const saved = await invoke("read_project_comments_anchored", {
            projectRoot,
          });
          return { times, frames, drainMs, saved: saved.files["main.tex"] };
        },
        { projectRoot, checkAutosave },
      );
      if (checkAutosave) {
        const duringTyping = await fs.readFile(
          path.join(projectRoot, "main.tex"),
          "utf8",
        );
        const savedEdits = duringTyping.match(/^x*/)[0].length;
        assert.ok(
          savedEdits > 0,
          "autosave reached disk without an idle pause",
        );
        await page.evaluate(async () => {
          const { useDocumentStore } = await import(
            "/src/renderer/stores/document-store.ts"
          );
          await useDocumentStore.getState().saveFile("main.tex");
        });
        assert.equal(
          await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"),
          `${"x".repeat(20)}Intro\n${source}`,
        );
        console.log(
          JSON.stringify({
            autosaveDuringTyping: savedEdits,
            finalDiskEdits: 20,
          }),
        );
      }
      if (profiler) {
        const { profile: cpuProfile } = await profiler.send("Profiler.stop");
        await fs.writeFile(
          path.join(os.tmpdir(), `catalex-comment-typing-${count}.cpuprofile`),
          JSON.stringify(cpuProfile),
        );
      }
      assert.equal(typing.saved.length, count);
      for (const comment of typing.saved) {
        const original = originals.get(comment.id);
        assert.equal(comment.from, original.from + 26);
        assert.equal(comment.to, original.to + 26);
        assert.equal(comment.text, original.text);
      }
      console.log(
        JSON.stringify({
          typing: {
            count,
            dispatchMs: typing.times,
            twoFramesMs: typing.frames,
            drainMs: typing.drainMs,
          },
        }),
      );
      if (reviewWorkload) {
        await profiler?.send("Profiler.start");
        await page.evaluate(async () => {
          const { useDocumentStore } = await import(
            "/src/renderer/stores/document-store.ts"
          );
          await useDocumentStore.getState().saveFile("main.tex");
        });
        const opened = performance.now();
        await page.evaluate(async (projectRoot) => {
          const { OPEN_COMMENT_MANAGER_EVENT } = await import(
            "/src/renderer/lib/workspace-events.ts"
          );
          window.dispatchEvent(
            new CustomEvent(OPEN_COMMENT_MANAGER_EVENT, {
              detail: { projectRoot },
            }),
          );
        }, projectRoot);
        const dialog = page.getByRole("dialog", { name: "Manage comments" });
        await dialog
          .getByRole("checkbox", { name: "Select file main.tex", exact: true })
          .waitFor();
        const managerOpenMs = performance.now() - opened;
        const expand = performance.now();
        await dialog
          .getByRole("button", {
            name: "Expand comments in main.tex",
            exact: true,
          })
          .click();
        await dialog
          .getByText(`Feedback ${count - 1}`, { exact: true })
          .waitFor();
        const managerExpandMs = performance.now() - expand;
        const select = performance.now();
        await dialog
          .getByRole("checkbox", { name: "Select file main.tex", exact: true })
          .check();
        await dialog.getByText("1/1 files selected", { exact: true }).waitFor();
        const managerSelectMs = performance.now() - select;
        const agentUpdates = await page.evaluate(async (projectRoot) => {
          const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
          const saved = await invoke("read_project_comments_anchored", {
            projectRoot,
          });
          const times = [];
          const targets = saved.files["main.tex"]
            .filter((c) => c.origin)
            .slice(0, 20);
          for (const before of targets) {
            const start = performance.now();
            await invoke("update_project_comment", {
              projectRoot,
              patch: {
                filePath: "main.tex",
                id: before.id,
                before,
                after: { ...before, text: `Agent revision ${before.id}` },
              },
            });
            times.push(performance.now() - start);
          }
          const after = await invoke("read_project_comments_anchored", {
            projectRoot,
          });
          for (const before of targets) {
            const current = after.files["main.tex"].find(
              (c) => c.id === before.id,
            );
            if (
              current.text !== `Agent revision ${before.id}` ||
              current.from !== before.from ||
              current.to !== before.to ||
              JSON.stringify(current.origin) !== JSON.stringify(before.origin)
            )
              throw new Error("Agent update changed unrelated data");
          }
          return { times, lastId: targets.at(-1).id };
        }, projectRoot);
        await dialog
          .getByText(`Agent revision ${agentUpdates.lastId}`, { exact: true })
          .waitFor();
        await page.screenshot({
          path: path.join(os.tmpdir(), `catalex-manager-${count}.png`),
        });
        await dialog
          .getByRole("button", { name: "Close", exact: true })
          .click();
        if (profiler) {
          const { profile: reviewProfile } =
            await profiler.send("Profiler.stop");
          await fs.writeFile(
            path.join(
              os.tmpdir(),
              `catalex-comment-review-${count}.cpuprofile`,
            ),
            JSON.stringify(reviewProfile),
          );
        }
        console.log(
          JSON.stringify({
            review: {
              count,
              managerOpenMs,
              managerExpandMs,
              managerSelectMs,
              agentUpdateMs: agentUpdates.times,
            },
          }),
        );
      }
      if (checkMemory) await checkManagerMemory(app, page, projectRoot, count);
      const artifacts = path.resolve(
        root,
        "../../output/playwright/comment-performance",
      );
      await fs.mkdir(artifacts, { recursive: true });
      await page.screenshot({
        path: path.join(artifacts, "many-comments.png"),
      });
    }
  }
} catch (error) {
  // A failed save can intentionally block normal window closing. Do not leave
  // a failed isolated test hanging in its recovery dialog.
  app?.process().kill();
  throw error;
} finally {
  if (app?.process().exitCode === null) await app.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
