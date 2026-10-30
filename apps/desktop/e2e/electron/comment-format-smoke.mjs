import { readCommentFixture, writeCommentFixture } from "./comment-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-comment-format-"),
);
const project = path.join(profile, "Project");
await fs.mkdir(project);
await fs.writeFile(path.join(project, "notes.md"), "before target after\n");
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
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  // Register an isolated project and create its local comment directory.
  await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    await invoke("read_project_comments_anchored", { projectRoot });
  }, project);
  const registry = JSON.parse(
    await fs.readFile(
      path.join(profile, "data", "project-registry.json"),
      "utf8",
    ),
  );
  const canonical = await fs.realpath(project);
  const entry = registry.projects.find((entry) =>
    entry.paths.includes(canonical),
  );
  const directory = path.join(
    profile,
    "data",
    "projects",
    entry.id,
    "comments",
  );
  for (const agent of [false, true]) {
    const file = path.join(directory, agent ? "agent.json" : "human.json");
    const comment = {
      id: agent ? "agent-current" : "human-current",
      number: 1,
      from: 7,
      to: 13,
      line: 1,
      text: "Keep this comment",
      resolved: false,
      ...(agent ? { origin: { provider: "codex", sessionId: "current" } } : {}),
    };
    {
      await writeCommentFixture(
        file,
        JSON.stringify({
          version: 1,
          counter: 1,
          files: { "notes.md": [comment] },
          sources: {},
        }),
      );
      const loaded = await page.evaluate(
        async ({ projectRoot, id }) => {
          const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
          const snapshot = await invoke("read_project_comments_anchored", {
            projectRoot,
          });
          const before = snapshot.files["notes.md"].find(
            (comment) => comment.id === id,
          );
          await invoke("update_project_comment", {
            projectRoot,
            patch: {
              filePath: "notes.md",
              id,
              before,
              after: { ...before, text: "Updated comment" },
            },
          });
          return before;
        },
        { projectRoot: project, id: comment.id },
      );
      assert.equal(loaded.text, comment.text);
      assert.equal(loaded.from, 7);
      assert.equal(loaded.to, 13);
      assert.equal("replies" in loaded, false);
      const saved = JSON.parse(await readCommentFixture(file, "utf8")).files[
        "notes.md"
      ][0];
      assert.equal(saved.text, "Updated comment");
      assert.equal("replies" in saved, false);
    }
  }
  console.log(
    "PASS: Electron reads and edits current PoloDB comments for both authors without reply fields.",
  );
} finally {
  if (app) {
    const closed = app.waitForEvent("close", { timeout: 10000 });
    await app
      .evaluate(({ app }) => {
        setImmediate(() => app.exit(0));
      })
      .catch(() => {});
    await closed.catch(() => app.process().kill("SIGKILL"));
  }
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
