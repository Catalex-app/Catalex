import { readCommentFixture, writeCommentFixture } from "./comment-fixture.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

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
const proposal = base
  .replace("10 samples", "15 samples")
  .replace("preliminary", "replicate independently");
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
async function preview(session) {
  return invoke("preview_agent_workspace", {
    ...projectArgs,
    sessionId: session.sessionId,
    decisions: [],
  });
}
async function draftStorage(session) {
  const id = await invoke("prepare_project_storage", {
    projectRoot: session.candidateRoot,
  });
  const data = path.join(profile, "data", "projects", id);
  const cache = path.join(profile, "project-cache", "projects", id);
  await fs.mkdir(path.join(cache, "latex-build"), { recursive: true });
  const marker = path.join(cache, "latex-build", "keep.pdf");
  await fs.writeFile(marker, "draft compilation cache");
  return { id, data, cache, marker };
}
async function assertDraftStorageRemoved(storage) {
  for (const dir of [storage.data, storage.cache]) {
    await assert.rejects(fs.stat(dir), { code: "ENOENT" });
  }
  const registry = JSON.parse(
    await fs.readFile(
      path.join(profile, "data", "project-registry.json"),
      "utf8",
    ),
  );
  assert.ok(!registry.projects.some((entry) => entry.id === storage.id));
}
try {
  await launch();
  await invoke("history_init", projectArgs);
  const session = await invoke("prepare_agent_workspace", {
    ...projectArgs,
    tabId: "worktree-smoke",
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  const storage = await draftStorage(session);
  assert.equal(session.version, 2);
  assert.ok(session.sourceCommit);
  assert.ok(session.baselineCommit);
  const sessionDir = path.dirname(session.candidateRoot);
  const gitLink = await fs.readFile(
    path.join(session.candidateRoot, ".git"),
    "utf8",
  );
  assert.match(gitLink, /^gitdir: /);
  for (const directory of ["source-snapshot", "baseline"]) {
    await assert.rejects(fs.stat(path.join(sessionDir, directory)), {
      code: "ENOENT",
    });
  }
  const privateGitDir = execFileSync(
    "git",
    ["-C", session.candidateRoot, "rev-parse", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();
  const sourceGitExists = await fs.stat(path.join(projectRoot, ".git")).then(
    () => true,
    () => false,
  );
  assert.equal(
    sourceGitExists,
    false,
    "private worktrees must not initialize user Git",
  );
  await fs.writeFile(
    path.join(session.candidateRoot, "manuscript.md"),
    proposal,
  );
  await fs.writeFile(
    path.join(session.candidateRoot, "checklist.md"),
    "Record sample identifiers.\nArchive the evaluation script.\n",
  );
  await fs.writeFile(path.join(projectRoot, "manuscript.md"), current);
  await invoke("reconcile_agent_workspace", {
    ...projectArgs,
    sessionId: session.sessionId,
    outcome: "success",
  });
  let plan = await preview(session);
  const manuscript = plan.changes.find(
    (change) => change.filePath === "manuscript.md",
  );
  const checklist = plan.changes.find(
    (change) => change.filePath === "checklist.md",
  );
  assert.ok(manuscript && checklist);
  const conflict = plan.conflictContents[manuscript.id].find(
    (segment) => segment.kind === "conflict",
  );
  assert.match(conflict.ancestor, /10 samples/);
  assert.match(conflict.current, /20 samples/);
  assert.match(conflict.agent, /15 samples/);
  assert.equal(
    await fs.readFile(path.join(projectRoot, "manuscript.md"), "utf8"),
    current,
  );
  const mainBeforeApply = await listHistory();
  const draftRefs = execFileSync(
    "git",
    [
      "--git-dir",
      privateGitDir,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/catalex/agents",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  assert.ok(
    mainBeforeApply.every((checkpoint) => !draftRefs.includes(checkpoint.id)),
    "rewind must exclude private agent commits",
  );

  const partial = await invoke("apply_agent_workspace", {
    ...projectArgs,
    sessionId: session.sessionId,
    expectedSourceRevision: plan.sourceRevision,
    decisions: [{ changeId: checklist.id, accept: true }],
  });
  assert.equal(partial.applied, true);
  assert.deepEqual(partial.changedPaths, ["checklist.md"]);
  assert.equal(partial.remainingPreview.changes.length, 1);
  assert.equal(partial.remainingPreview.changes[0].filePath, "manuscript.md");
  assert.equal(
    await fs.readFile(path.join(projectRoot, "manuscript.md"), "utf8"),
    current,
  );
  assert.match(
    await fs.readFile(path.join(projectRoot, "checklist.md"), "utf8"),
    /Archive/,
  );
  const partialHistory = await listHistory();
  assert.equal(partialHistory[0].message, "[agent] Applied reviewed changes");
  assert.match(
    await invoke("history_file_at", {
      ...projectArgs,
      snapshotId: partialHistory[0].id,
      filePath: "checklist.md",
    }),
    /Archive/,
  );

  // Opening a project and refining after partial acceptance must retain cache,
  // proposals, and the existing draft identity.
  await invoke("prepare_project_storage", projectArgs);
  await fs.stat(storage.marker);
  const refined = await invoke("resume_agent_workspace", {
    ...projectArgs,
    sessionId: session.sessionId,
    tabId: "worktree-smoke",
    sharedSessionId: null,
  });
  assert.equal(refined.candidateRoot, session.candidateRoot);
  assert.equal(refined.sessionId, session.sessionId);
  assert.equal((await preview(refined)).changes.length, 1);
  await invoke("reconcile_agent_workspace", {
    ...projectArgs,
    sessionId: session.sessionId,
    outcome: "success",
  });
  await fs.stat(storage.marker);

  // Clearing main-project history must not invalidate pending draft objects.
  await invoke("history_clear", projectArgs);
  assert.equal((await listHistory()).length, 1);
  assert.equal((await preview(session)).changes.length, 1);
  await app.close();
  app = undefined;
  await launch();
  const recovered = await invoke("list_agent_workspaces", projectArgs);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].sessionId, session.sessionId);
  assert.equal(recovered[0].candidateRoot, session.candidateRoot);
  await fs.stat(storage.marker);
  plan = await preview(recovered[0]);
  assert.equal(plan.changes.length, 1);
  const remaining = plan.changes[0];
  assert.ok(
    plan.conflictContents[remaining.id].some(
      (segment) => segment.kind === "conflict",
    ),
  );
  const resolved = plan.conflictContents[remaining.id]
    .map((segment) =>
      segment.kind === "resolved" ? segment.content : segment.agent,
    )
    .join("");
  assert.equal(
    await fs.readFile(path.join(projectRoot, "manuscript.md"), "utf8"),
    current,
  );
  const applied = await invoke("apply_agent_workspace", {
    ...projectArgs,
    sessionId: session.sessionId,
    expectedSourceRevision: plan.sourceRevision,
    decisions: [
      {
        changeId: remaining.id,
        accept: true,
        content: resolved,
        resolvedConflict: true,
        proposalRevision: remaining.proposalRevision,
      },
    ],
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.remainingPreview == null, true);
  assert.equal(
    await fs.readFile(path.join(projectRoot, "manuscript.md"), "utf8"),
    resolved,
  );
  assert.match(resolved, /15 samples/);
  assert.match(resolved, /replicate independently/);
  const appliedHistory = await listHistory();
  assert.equal(appliedHistory[0].message, "[agent] Applied reviewed changes");
  assert.equal(
    await invoke("history_file_at", {
      ...projectArgs,
      snapshotId: appliedHistory[0].id,
      filePath: "manuscript.md",
    }),
    resolved,
  );
  // Simulate exit after native application but before renderer cleanup. Recovery
  // must reclaim the settled worktree while keeping its main-project checkpoint.
  await fs.stat(session.candidateRoot);
  await app.close();
  app = undefined;
  await launch();
  assert.deepEqual(await invoke("list_agent_workspaces", projectArgs), []);
  await assert.rejects(fs.stat(session.candidateRoot), { code: "ENOENT" });
  await assertDraftStorageRemoved(storage);
  assert.equal((await listHistory())[0].id, appliedHistory[0].id);
  assert.equal(
    await fs.readFile(path.join(projectRoot, "manuscript.md"), "utf8"),
    resolved,
  );
  // Emulate a stopped native process after project publication but before
  // candidate/session publication. Unit tests cover the other boundaries.
  const interrupted = await invoke("prepare_agent_workspace", {
    ...projectArgs,
    tabId: "recovery-smoke",
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  const interruptedDir = path.dirname(interrupted.candidateRoot);
  const beforeText = await fs.readFile(
    path.join(projectRoot, "checklist.md"),
    "utf8",
  );
  const approvedText = `${beforeText}Keep the recovery checkpoint.\n`;
  const pendingText = `${resolved}\nRefine this paragraph later.\n`;
  await fs.writeFile(
    path.join(interrupted.candidateRoot, "checklist.md"),
    approvedText,
  );
  await fs.writeFile(
    path.join(interrupted.candidateRoot, "manuscript.md"),
    pendingText,
  );
  await invoke("reconcile_agent_workspace", {
    ...projectArgs,
    sessionId: interrupted.sessionId,
    outcome: "success",
  });
  await app.close();
  app = undefined;
  const manifest = JSON.parse(
    await fs.readFile(path.join(interruptedDir, "session.json"), "utf8"),
  );
  const gitEnv = {
    ...process.env,
    GIT_INDEX_FILE: path.join(profile, "recovery-fixture-index"),
    GIT_AUTHOR_NAME: "Recovery test",
    GIT_AUTHOR_EMAIL: "recovery@local",
    GIT_COMMITTER_NAME: "Recovery test",
    GIT_COMMITTER_EMAIL: "recovery@local",
  };
  const git = (args, input) =>
    execFileSync("git", ["--git-dir", privateGitDir, ...args], {
      encoding: "utf8",
      env: gitEnv,
      input,
    }).trim();
  const beforeBlob = git(["hash-object", "-w", "--stdin"], beforeText);
  const afterBlob = git(["hash-object", "-w", "--stdin"], approvedText);
  function nextCommit(parent, kind) {
    git(["read-tree", parent]);
    git([
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${afterBlob},checklist.md`,
    ]);
    const tree = git(["write-tree"]);
    const commit = git([
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      "Interrupted acceptance fixture",
    ]);
    git([
      "update-ref",
      `refs/catalex/agents/${interrupted.sessionId}/${kind}/${commit}`,
      commit,
    ]);
    return commit;
  }
  const pendingSession = {
    ...manifest,
    sourceCommit: nextCommit(manifest.sourceCommit, "source"),
    baselineCommit: nextCommit(manifest.baselineCommit, "baseline"),
    status: "review",
  };
  const afterFiles = { "checklist.md": { blob: afterBlob, mode: 0o100644 } };
  await fs.writeFile(
    path.join(interruptedDir, "settlement.json"),
    JSON.stringify({
      version: 2,
      direction: "apply",
      session: pendingSession,
      before: { "checklist.md": { blob: beforeBlob, mode: 0o100644 } },
      candidate_before: afterFiles,
      after: afterFiles,
      changed_paths: ["checklist.md"],
      comment_storage: null,
    }),
  );
  await fs.writeFile(path.join(projectRoot, "checklist.md"), approvedText);
  await launch();
  const resumed = await invoke("list_agent_workspaces", projectArgs);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].sessionId, interrupted.sessionId);
  const remainingPlan = await preview(resumed[0]);
  assert.deepEqual(
    remainingPlan.changes.map((change) => change.filePath),
    ["manuscript.md"],
  );
  assert.equal(
    await fs.readFile(
      path.join(interrupted.candidateRoot, "manuscript.md"),
      "utf8",
    ),
    pendingText,
  );
  assert.equal(
    await fs.readFile(path.join(projectRoot, "manuscript.md"), "utf8"),
    resolved,
  );
  assert.equal(
    await fs.readFile(
      path.join(interrupted.candidateRoot, "checklist.md"),
      "utf8",
    ),
    approvedText,
  );
  for (const name of ["settlement.json", "rollback", "history-pending"]) {
    await assert.rejects(fs.stat(path.join(interruptedDir, name)), {
      code: "ENOENT",
    });
  }
  const recoveredHistory = await listHistory();
  assert.equal(recoveredHistory[0].message, "[agent] Recovered checkpoint");
  await app.close();
  app = undefined;
  await launch();
  assert.equal((await listHistory())[0].id, recoveredHistory[0].id);
  assert.equal((await preview(interrupted)).changes.length, 1);
  await invoke("discard_agent_workspace", {
    ...projectArgs,
    sessionId: interrupted.sessionId,
  });
  // Acceptance and its Rewind checkpoint must survive unavailable comment
  // storage. The comment job belongs to the project, not the disposable draft.
  const commentStorage = path.join(
    path.dirname(path.dirname(sessionDir)),
    "comments",
  );
  await fs.mkdir(commentStorage, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "commented.tex"), "source passage");
  await writeCommentFixture(
    path.join(commentStorage, "human.json"),
    JSON.stringify({
      version: 1,
      counter: 1,
      files: {
        "commented.tex": [
          {
            id: "H-recovery",
            number: 1,
            from: 0,
            to: 6,
            line: 1,
            text: "Preserve this feedback",
            resolved: false,
          },
        ],
      },
    }),
  );
  await invoke("read_project_comments_anchored", projectArgs);
  const commentSession = await invoke("prepare_agent_workspace", {
    ...projectArgs,
    tabId: "comment-recovery-smoke",
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  await fs.rename(
    path.join(commentSession.candidateRoot, "commented.tex"),
    path.join(commentSession.candidateRoot, "renamed.tex"),
  );
  await invoke("reconcile_agent_workspace", {
    ...projectArgs,
    sessionId: commentSession.sessionId,
    outcome: "success",
  });
  let commentPlan = await preview(commentSession);
  // A failed durable handoff must cancel before publishing project files.
  const recoveryDirectory = `${commentStorage}.recovery`;
  await fs.rm(recoveryDirectory, { recursive: true, force: true });
  await fs.writeFile(recoveryDirectory, "Recovery storage unavailable fixture");
  await assert.rejects(
    invoke("apply_agent_workspace", {
      ...projectArgs,
      sessionId: commentSession.sessionId,
      decisions: commentPlan.changes.map((change) => ({
        changeId: change.id,
        accept: true,
      })),
      expectedSourceRevision: commentPlan.sourceRevision,
    }),
  );
  assert.equal(
    await fs.readFile(path.join(projectRoot, "commented.tex"), "utf8"),
    "source passage",
  );
  await assert.rejects(fs.stat(path.join(projectRoot, "renamed.tex")), {
    code: "ENOENT",
  });
  await app.close();
  app = undefined;
  await fs.rm(recoveryDirectory);
  await launch();
  await invoke("list_agent_workspaces", projectArgs);
  assert.equal(
    await fs.readFile(path.join(projectRoot, "commented.tex"), "utf8"),
    "source passage",
  );
  commentPlan = await preview(commentSession);
  await fs.rename(commentStorage, `${commentStorage}.saved`);
  await fs.writeFile(commentStorage, "Storage unavailable fixture");
  const historyBeforeCommentFailure = (await listHistory()).map(
    (item) => item.id,
  );
  const commentApply = await invoke("apply_agent_workspace", {
    ...projectArgs,
    sessionId: commentSession.sessionId,
    decisions: commentPlan.changes.map((change) => ({
      changeId: change.id,
      accept: true,
    })),
    expectedSourceRevision: commentPlan.sourceRevision,
  });
  assert.equal(commentApply.applied, true);
  assert.equal(commentApply.remainingPreview ?? null, null);
  assert.ok(commentApply.commentWarning);
  assert.deepEqual(
    (await listHistory()).map((item) => item.id),
    historyBeforeCommentFailure,
  );
  await assert.rejects(
    fs.stat(
      path.join(path.dirname(commentSession.candidateRoot), "settlement.json"),
    ),
    { code: "ENOENT" },
  );
  await assert.rejects(
    invoke("discard_agent_workspace", {
      ...projectArgs,
      sessionId: commentSession.sessionId,
    }),
  );
  await app.close();
  app = undefined;
  await launch();
  const pendingSessions = await invoke("list_agent_workspaces", projectArgs);
  assert.equal(pendingSessions.length, 1);
  assert.equal(pendingSessions[0].status, "settled");
  assert.ok(
    pendingSessions[0].warnings.some((warning) =>
      warning.startsWith("History checkpoint pending:"),
    ),
  );
  assert.deepEqual(
    (await listHistory()).map((item) => item.id),
    historyBeforeCommentFailure,
  );
  await fs.writeFile(path.join(projectRoot, "later.md"), "Newer user work");
  await assert.rejects(invoke("read_project_comments_anchored", projectArgs));
  assert.equal(
    await fs.readFile(path.join(projectRoot, "renamed.tex"), "utf8"),
    "source passage",
  );
  await fs.rm(commentStorage);
  await fs.rename(`${commentStorage}.saved`, commentStorage);
  const recoveredComments = await invoke(
    "read_project_comments_anchored",
    projectArgs,
  );
  assert.equal(recoveredComments.files["renamed.tex"][0].id, "H-recovery");
  assert.deepEqual(recoveredComments.orphanedPaths, []);
  assert.deepEqual(await fs.readdir(`${commentStorage}.recovery`), []);
  assert.deepEqual(await invoke("list_agent_workspaces", projectArgs), []);
  const recoveredCheckpoint = (await listHistory())[0];
  assert.equal(recoveredCheckpoint.message, "[agent] Recovered checkpoint");
  assert.equal(
    await invoke("history_file_at", {
      ...projectArgs,
      snapshotId: recoveredCheckpoint.id,
      filePath: "later.md",
    }),
    "Newer user work",
  );
  await invoke("list_agent_workspaces", projectArgs);
  assert.equal((await listHistory())[0].id, recoveredCheckpoint.id);

  await app.close();
  app = undefined;
  await launch();
  assert.equal(
    (await invoke("read_project_comments_anchored", projectArgs)).files[
      "renamed.tex"
    ][0].id,
    "H-recovery",
  );

  // Malformed metadata must be backed up, not block a valid Rewind restore.
  await invoke("history_snapshot", {
    ...projectArgs,
    message: "Before malformed comments",
  });
  const validCheckpoint = (await listHistory())[0];
  await fs.writeFile(path.join(projectRoot, "renamed.tex"), "new source work");
  await writeCommentFixture(
    path.join(commentStorage, "human.json"),
    "broken comment metadata",
  );
  await invoke("history_restore", {
    ...projectArgs,
    snapshotId: validCheckpoint.id,
  });
  assert.equal(
    await fs.readFile(path.join(projectRoot, "renamed.tex"), "utf8"),
    "source passage",
  );
  const beforeRestore = (await listHistory()).find((item) =>
    item.message.startsWith("[before-restore]"),
  );
  assert.ok(beforeRestore);
  await invoke("history_restore", {
    ...projectArgs,
    snapshotId: beforeRestore.id,
  });
  assert.equal(
    await fs.readFile(path.join(projectRoot, "renamed.tex"), "utf8"),
    "new source work",
  );
  assert.equal(
    await readCommentFixture(path.join(commentStorage, "human.json"), "utf8"),
    "broken comment metadata",
  );

  // Known copied-folder drafts are retired without migrating or touching files.
  const live = await invoke("prepare_agent_workspace", {
    ...projectArgs,
    tabId: "retirement-current",
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  const oldRoot = path.join(
    path.dirname(path.dirname(live.candidateRoot)),
    "legacy-copy",
  );
  await fs.mkdir(path.join(oldRoot, "candidate-migration"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(oldRoot, "candidate-migration", "unaccepted.tex"),
    "discard old draft",
  );
  await fs.writeFile(
    path.join(oldRoot, "session.json"),
    JSON.stringify({
      ...live,
      version: 1,
      sessionId: "legacy-copy",
      candidateRoot: path.join(oldRoot, "candidate"),
      sourceSnapshotRoot: path.join(oldRoot, "source-snapshot"),
      baselineRoot: path.join(oldRoot, "baseline"),
      status: "resume-backup",
    }),
  );
  const beforeRetirement = (await listHistory()).map((item) => item.id);
  const mixed = await invoke("list_agent_workspaces", projectArgs);
  assert.ok(
    mixed.some(
      (item) => item.sessionId === live.sessionId && item.version === 2,
    ),
  );
  assert.ok(
    mixed.some(
      (item) => item.sessionId === "legacy-copy" && item.status === "cancelled",
    ),
  );
  await assert.rejects(fs.stat(oldRoot), { code: "ENOENT" });
  assert.deepEqual(
    (await listHistory()).map((item) => item.id),
    beforeRetirement,
  );
  assert.equal(
    await fs.readFile(path.join(projectRoot, "renamed.tex"), "utf8"),
    "new source work",
  );
  assert.equal(
    await readCommentFixture(path.join(commentStorage, "human.json"), "utf8"),
    "broken comment metadata",
  );
  await app.close();
  app = undefined;
  await launch();
  const reopened = await invoke("list_agent_workspaces", projectArgs);
  assert.ok(reopened.some((item) => item.sessionId === live.sessionId));
  assert.ok(!reopened.some((item) => item.sessionId === "legacy-copy"));

  // Old missing drafts are reclaimed on project open, including idempotent
  // retries, without deleting a surviving paused/backup draft.
  const old = await invoke("prepare_agent_workspace", {
    ...projectArgs,
    tabId: "old-cache",
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  const oldStorage = await draftStorage(old);
  const liveStorage = await draftStorage(live);
  await fs.rm(path.dirname(old.candidateRoot), { recursive: true });
  await invoke("prepare_project_storage", projectArgs);
  await assertDraftStorageRemoved(oldStorage);
  await invoke("prepare_project_storage", projectArgs);
  await fs.stat(liveStorage.marker);
  await invoke("set_agent_workspace_backup", {
    ...projectArgs,
    sessionId: live.sessionId,
    backup: true,
  });
  await invoke("prepare_project_storage", projectArgs);
  await fs.stat(liveStorage.marker);
  await invoke("discard_agent_workspace", {
    ...projectArgs,
    sessionId: live.sessionId,
  });
  await assertDraftStorageRemoved(liveStorage);

  // Real compiler subprocess: removing its draft must not delete the staged
  // cache while the build is running. Reopening retries after it has finished.
  const compileProject = path.join(profile, "Compile cleanup");
  await fs.mkdir(compileProject);
  await fs.writeFile(
    path.join(compileProject, "main.tex"),
    "\\documentclass{article}\n",
  );
  const compiling = await invoke("prepare_agent_workspace", {
    projectRoot: compileProject,
    tabId: "compile-cleanup",
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  const compilingStorage = await draftStorage(compiling);
  const tools = path.join(profile, "compiler");
  const started = path.join(profile, "compiler-started");
  const release = path.join(profile, "compiler-release");
  await fs.mkdir(tools);
  await fs.writeFile(path.join(tools, "pdflatex"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await fs.writeFile(
    path.join(tools, "latexmk"),
    `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(started)}, 'started');
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  fs.copyFileSync(${JSON.stringify(path.join(desktopRoot, "public/examples/letter-formal/main.pdf"))}, 'main.pdf');
}, 20);
`,
    { mode: 0o755 },
  );
  const build = invoke("compile_latex", {
    projectDir: compiling.candidateRoot,
    mainFile: "main.tex",
    backend: "latexmk",
    engine: "pdflatex",
    installation: tools,
    diagnostics: { __channel: 0 },
  });
  await expect
    .poll(
      () =>
        fs.stat(started).then(
          () => true,
          () => false,
        ),
      {
        timeout: 15000,
      },
    )
    .toBe(true);
  await invoke("discard_agent_workspace", {
    projectRoot: compileProject,
    sessionId: compiling.sessionId,
  });
  await invoke("prepare_project_storage", { projectRoot: compileProject });
  await fs.stat(compilingStorage.marker);
  await fs.writeFile(release, "finish");
  const pdf = await build;
  assert.ok(pdf.length > 100);
  await invoke("prepare_project_storage", { projectRoot: compileProject });
  await assertDraftStorageRemoved(compilingStorage);
  console.log(
    "Draft storage cleanup passed: partial acceptance/refinement retention, restart settlement, old leftovers, backup retention, discard, active compilation and retry.",
  );

  console.log(
    "Electron worktree IPC smoke passed: private Git isolation, three-way conflicts, partial apply, history clear, full restart recovery, explicit resolution, native rewind checkpoints, settled-worktree cleanup after restart, Git-object acceptance recovery after process restart, failed handoff cancellation across restart, nonblocking comment-storage failure, delayed complete checkpoints across restart with newer user edits, Rewind with preserved malformed metadata, mixed old/current draft retirement across restart.",
  );
} finally {
  if (app) await app.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
