import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

// Real Electron preload + native-service IPC. The separate browser harness owns
// rendered controls; this minimal page avoids background project autosaves.
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-agent-worktree-"),
);
const projectRoot = path.join(profile, "Riverside Study");
await fs.mkdir(projectRoot);
const base =
  "# Study\n\nWe evaluated 10 samples.\n\nConclusion: preliminary.\n";
const current = base.replace("10 samples", "20 samples");
await fs.writeFile(path.join(projectRoot, "manuscript.md"), base);
await fs.writeFile(
  path.join(projectRoot, "checklist.md"),
  "Record sample identifiers.\n",
);
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    "<!doctype html><html><body><h1>Agent worktree IPC smoke</h1></body></html>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: `http://127.0.0.1:${server.address().port}`,
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
async function launch() {
  app = await electron.launch({ args: [desktopRoot], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.catalex));
}
async function invoke(command, args = {}) {
  return page.evaluate(
    async ({ command, args }) => {
      const response = await window.catalex.invoke(command, args);
      if ("error" in response) throw new Error(JSON.stringify(response.error));
      return response.result;
    },
    { command, args },
  );
}
const projectArgs = { projectRoot };
async function listHistory() {
  return invoke("history_list", { ...projectArgs, limit: 100, offset: 0 });
}
try {
  await launch();
  await invoke("history_init", projectArgs);
  const first = (await listHistory())[0].id;
  await fs.writeFile(path.join(projectRoot, "manuscript.md"), current);
  const second = (
    await invoke("history_snapshot", {
      ...projectArgs,
      message: "[manual] Save",
    })
  ).id;
  const label = "First draft / 初稿 ✨";
  for (const snapshotId of [first, second, second])
    await invoke("history_add_label", { ...projectArgs, snapshotId, label });
  assert.deepEqual(await invoke("history_label_counts", projectArgs), {
    [label]: 2,
  });
  await assert.rejects(
    invoke("history_add_label", {
      ...projectArgs,
      snapshotId: first,
      label: " Agent ",
    }),
  );
  const other = path.join(profile, "Other project");
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, "main.tex"), "other");
  await invoke("history_init", { projectRoot: other });
  assert.deepEqual(
    await invoke("history_label_counts", { projectRoot: other }),
    {},
  );
  await app.close();
  app = undefined;
  await launch();
  assert.deepEqual(await invoke("history_label_counts", projectArgs), {
    [label]: 2,
  });
  await invoke("history_remove_label", {
    ...projectArgs,
    snapshotId: first,
    label,
  });
  assert.deepEqual(await invoke("history_label_counts", projectArgs), {
    [label]: 1,
  });
  assert.deepEqual(
    (await listHistory()).find((item) => item.id === second).labels,
    [label],
  );
  await invoke("history_remove_label", {
    ...projectArgs,
    snapshotId: second,
    label,
  });
  assert.deepEqual(await invoke("history_label_counts", projectArgs), {});
  console.log(
    "History label IPC passed: Unicode, reuse, idempotence, reserved names, per-project counts, restart and scoped removal.",
  );
} finally {
  if (app) await app.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
