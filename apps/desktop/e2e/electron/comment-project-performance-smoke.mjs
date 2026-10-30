import { writeCommentFixture } from "./comment-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-comment-project-performance-"),
);
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
const hash = (text) => createHash("sha1").update(text).digest("hex");
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
  for (const fileCount of [1, 20, 200]) {
    const projectRoot = path.join(profile, `project-${fileCount}`);
    await fs.mkdir(projectRoot);
    const source =
      "A sentence with words for testing comment performance.\n".repeat(4000);
    const revision = hash(source);
    const comments = Array.from({ length: 1000 }, (_, index) => ({
      id: `c-${index}`,
      number: index + 1,
      from: index * 220,
      to: index * 220 + 10,
      line: index * 4 + 1,
      text: `Feedback ${index}`,
      anchorRevision: revision,
    }));
    const files = { "main.tex": comments };
    const sources = { [revision]: source };
    const revisions = { "main.tex": [revision] };
    await fs.writeFile(path.join(projectRoot, "main.tex"), source);
    const measured = async (command, args = {}) =>
      page.evaluate(
        async ({ command, args, projectRoot }) => {
          const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
          const start = performance.now();
          const value = await invoke(command, { projectRoot, ...args });
          return { ms: performance.now() - start, value };
        },
        { command, args, projectRoot },
      );
    await measured("read_project_comments_anchored");
    const registry = JSON.parse(
      await fs.readFile(
        path.join(profile, "data/project-registry.json"),
        "utf8",
      ),
    );
    const canonical = await fs.realpath(projectRoot);
    const entry = registry.projects.find((entry) =>
      entry.paths.includes(canonical),
    );
    const storage = path.join(profile, "data/projects", entry.id, "comments");
    await fs.mkdir(storage, { recursive: true });
    for (let index = 1; index < fileCount; index++) {
      const file = `other-${index}.tex`;
      const text = fileCount === 200 ? source : source + index;
      const revision = hash(text);
      await fs.writeFile(path.join(projectRoot, file), text);
      files[file] = [
        {
          ...comments[0],
          id: `other-${index}`,
          number: 1000 + index,
          anchorRevision: revision,
        },
      ];
      sources[revision] = text;
      revisions[file] = [revision];
    }
    await writeCommentFixture(
      path.join(storage, "human.json"),
      JSON.stringify({
        version: 1,
        counter: 1000 + fileCount,
        files,
        sources,
        revisions,
      }),
    );
    const read = await measured("read_project_comments_anchored");
    assert.deepEqual(read.value.counters, [1000 + fileCount, 0]);
    const saveMs = await page.evaluate(
      async ({ projectRoot, comments, source }) => {
        const { saveProjectInlineComments } = await import(
          "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
        );
        const start = performance.now();
        await saveProjectInlineComments(
          projectRoot,
          { "main.tex": comments },
          {
            "main.tex": comments.map((c) => ({
              ...c,
              from: c.from + 1,
              to: c.to + 1,
            })),
          },
          { "main.tex": " " + source },
        );
        return performance.now() - start;
      },
      { projectRoot, comments, source },
    );
    const saved = await measured("read_project_comments_anchored");
    assert.equal(saved.value.files["main.tex"].length, 1000);
    assert.equal(
      saved.value.files["main.tex"].find((c) => c.id === "c-0").from,
      1,
    );
    console.log(
      JSON.stringify({
        fileCount,
        comments: 1000,
        bytesPerFile: source.length,
        readMs: read.ms,
        saveMs,
      }),
    );
    if (fileCount !== 1) continue;
    const individualStart = performance.now();
    for (const before of saved.value.files["main.tex"].slice(0, 100)) {
      await measured("update_project_comment", {
        patch: {
          filePath: "main.tex",
          id: before.id,
          before,
          after: { ...before, resolved: true },
        },
      });
    }
    const individual100Ms = performance.now() - individualStart;
    await fs.writeFile(path.join(projectRoot, "main.tex"), "Intro\n " + source);
    const recovery = await measured("read_project_comments_anchored");
    assert.equal(recovery.value.files["main.tex"].length, 1000);
    for (const comment of recovery.value.files["main.tex"]) {
      const original = comments.find((c) => c.id === comment.id);
      assert.equal(comment.from, original.from + 7);
      assert.equal(comment.to, original.to + 7);
      assert.equal(comment.line, original.line + 1);
      assert.equal(comment.text, original.text);
    }
    await fs.rename(
      path.join(projectRoot, "main.tex"),
      path.join(projectRoot, "moved.tex"),
    );
    const groups = await measured("read_project_comments_anchored", {
      includeDisconnected: true,
    });
    const relink = await measured("manage_comment_files", {
      selection: Object.entries(groups.value.disconnected).map(
        ([path, comments]) => ({
          path,
          disconnected: true,
          ids: comments.map((c) => c.id),
        }),
      ),
      action: "auto-relink",
      author: "all",
      target: "",
      preview: false,
    });
    assert.equal(relink.value.linked, 1000);
    const final = await measured("read_project_comments_anchored");
    assert.deepEqual(
      final.value.files["moved.tex"],
      recovery.value.files["main.tex"],
    );
    console.log(
      JSON.stringify({
        individual100Ms,
        externalRecoveryMs: recovery.ms,
        autoRelinkMs: relink.ms,
      }),
    );
  }
} finally {
  await app?.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
