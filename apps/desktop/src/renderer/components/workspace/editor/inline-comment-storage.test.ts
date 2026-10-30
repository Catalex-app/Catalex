import { invoke } from "@/lib/desktop/core";
import { createHash } from "node:crypto";
import { DocumentModel } from "@/lib/document-model";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { isCommentSaving, subscribeCommentSaving } from "./comment-save-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InlineEditorComment } from "./inline-comments";
import {
  getUnsavedCommentFiles,
  resolveCommentSaveConflict,
  COMMENT_SAVE_PROGRESS_EVENT,
  clearProjectComments,
  flushProjectCommentWrites,
  withCommentPathMutation,
  wasCommentCleared,
  applyCommentPatch,
  applyCommentPatches,
  replayProjectComment,
  commentPatches,
  commentHistoryPatches,
  loadProjectInlineComments,
  loadProjectCommentSnapshot,
  invalidateProjectCommentSnapshot,
  saveProjectInlineComments,
} from "./inline-comment-storage";

const human: InlineEditorComment = {
  id: "human",
  from: 0,
  to: 4,
  line: 1,
  text: "Clarify",
};
const agent: InlineEditorComment = {
  ...human,
  id: "agent",
  origin: {
    provider: "codex",
    sessionId: "session",
    model: "gpt-5.4",
    thinkingEffort: "high",
  },
};
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useDocumentStore.setState({
    projectRoot: null,
    agentWorkspaceRoot: null,
    files: [],
  });
});

function dirtyBuffer(root: string, text: string) {
  useDocumentStore.setState({
    projectRoot: root,
    files: [
      {
        id: "main.tex",
        relativePath: "main.tex",
        absolutePath: `${root}/main.tex`,
        content: text,
        isDirty: true,
      } as ProjectFile,
    ],
  });
}

describe("app-managed comment patches", () => {
  it("reads once after a queued save acknowledgement invalidates the snapshot", async () => {
    const root = "/read-after-acknowledgement";
    const edited = { ...human, text: "Saved feedback" };
    let finish!: () => void;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "update_project_comment") {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        invalidateProjectCommentSnapshot(root);
        return args!.patch;
      }
      return { files: { "main.tex": [edited] }, sources: {}, counters: [1, 0] };
    });
    const save = saveProjectInlineComments(
      root,
      { "main.tex": [human] },
      { "main.tex": [edited] },
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const read = loadProjectCommentSnapshot(root);
    finish();
    await save;
    expect((await read).files["main.tex"]).toEqual([edited]);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) => command === "read_project_comments_anchored",
        ),
    ).toHaveLength(1);
  });

  it("discards an invalidated late read before it restores obsolete disconnection metadata", async () => {
    const root = "/late-invalidated-snapshot";
    let finish!: (value: unknown) => void;
    vi.mocked(invoke)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        files: { "main.tex": [human] },
        sources: {},
        counters: [3, 0],
      });
    const old = loadProjectCommentSnapshot(root);
    invalidateProjectCommentSnapshot(root);
    const fresh = await loadProjectCommentSnapshot(root);
    finish({
      files: {},
      orphanedIds: [human.id],
      sources: {},
      counters: [3, 0],
    });
    expect(await old).toEqual(fresh);
    const { isCommentDetached } = await import("./comment-paths");
    expect(isCommentDetached(root, human.id)).toBe(false);
  });

  it("shares pending snapshots and releases successful and failed reads", async () => {
    const root = "/shared-snapshot";
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = loadProjectCommentSnapshot(root);
    const second = loadProjectCommentSnapshot(root);
    expect(invoke).toHaveBeenCalledTimes(1);
    finish({ files: { "main.tex": [human] }, sources: {} });
    expect(await first).toEqual(await second);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(loadProjectCommentSnapshot(root)).rejects.toThrow(
      "Storage unavailable",
    );
    vi.mocked(invoke).mockResolvedValueOnce({ files: {}, sources: {} });
    expect(await loadProjectCommentSnapshot(root)).toMatchObject({ files: {} });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("does not reuse pending reads across projects, manager options or invalidation", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(invoke)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        files: {},
        disconnected: { "gone.tex": [agent] },
        sources: {},
      });
    const root = "/invalidated-snapshot";
    const old = loadProjectCommentSnapshot(root);
    expect((await loadProjectCommentSnapshot(root, true)).disconnected).toEqual(
      { "gone.tex": [agent] },
    );
    await loadProjectCommentSnapshot("/other-snapshot");
    invalidateProjectCommentSnapshot(root);
    await loadProjectCommentSnapshot(root);
    expect(invoke).toHaveBeenCalledTimes(4);
    finish({ files: {}, sources: {} });
    await old;
  });

  it("keeps message and resolution history while excluding anchor-only and UI changes", () => {
    const before = { "main.tex": [human, agent] };
    const shifted = {
      ...human,
      from: 3,
      to: 7,
      anchorRevision: "new",
      resolved: false,
      isEditing: true,
    };
    const editedAgent = {
      ...agent,
      text: "Revised feedback",
      from: 10,
      to: 14,
    };
    const after = { "main.tex": [shifted, editedAgent] };
    const history = commentHistoryPatches(before, after);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: agent.id,
      before: agent,
      after: editedAgent,
    });
    expect(commentPatches(before, after)).toHaveLength(2);
    expect(
      commentHistoryPatches(after, {
        "main.tex": [{ ...shifted, resolved: true }, editedAgent],
      }),
    ).toEqual([
      expect.objectContaining({
        id: human.id,
        after: expect.objectContaining({ resolved: true }),
      }),
    ]);
    expect(
      commentHistoryPatches(before, {
        "main.tex": [agent, { ...human, id: "new" }],
      }).map((p) => p.id),
    ).toEqual([human.id, "new"]);
    expect(human.from).toBe(0);
  });

  it("does not save or number a discarded draft", () => {
    const draft = { ...human, text: "", isEditing: true };
    expect(commentPatches({}, { "main.tex": [draft] })).toEqual([]);
    expect(commentPatches({ "main.tex": [draft] }, {})).toEqual([]);
  });

  it("accepts the server-assigned number without overwriting local edits", () => {
    const local = { ...human, text: "New local edit", isEditing: true };
    const files = applyCommentPatch(
      { "main.tex": [local] },
      {
        filePath: "main.tex",
        id: human.id,
        before: null,
        after: { ...human, number: 13 },
      },
    );
    expect(files["main.tex"][0]).toEqual({ ...local, number: 13 });
    expect(commentPatches({}, files)[0].after?.number).toBe(13);
  });
  it("retains resolved comments and merges resolution from the backend", () => {
    const resolved = { ...human, resolved: true };
    const patch = commentPatches(
      { "main.tex": [human] },
      { "main.tex": [resolved] },
    )[0];
    expect(patch.after).toEqual(resolved);
    expect(
      applyCommentPatch(
        { "main.tex": [human] },
        { ...patch, before: { ...human, resolved: false } },
      )["main.tex"],
    ).toEqual([resolved]);
    expect(commentPatches({ "main.tex": [resolved] }, {})[0].after).toBeNull();
  });
  it("loads the merged collection from the app", async () => {
    vi.mocked(invoke).mockResolvedValue({
      files: { "main.tex": [human, agent] },
      sources: {},
    });
    expect(await loadProjectInlineComments("/project")).toEqual({
      "main.tex": [human, agent],
    });
    expect(invoke).toHaveBeenCalledWith("read_project_comments_anchored", {
      projectRoot: "/project",
    });
  });
  it("sends only local changes, never a replacement snapshot", async () => {
    const edited = { ...human, text: "Edited" };
    await saveProjectInlineComments(
      "/project",
      { "main.tex": [human] },
      { "main.tex": [edited] },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("update_project_comment", {
      projectRoot: "/project",
      patch: {
        filePath: "main.tex",
        id: human.id,
        before: human,
        after: edited,
      },
    });
  });
  it("does not save blank drafts or editing state", () => {
    expect(
      commentPatches(
        {},
        { "main.tex": [{ ...human, text: "", isEditing: true }] },
      ),
    ).toEqual([]);
    expect(
      commentPatches(
        { "main.tex": [agent] },
        { "main.tex": [{ ...agent, isEditing: true }] },
      ),
    ).toEqual([]);
  });
  it("preserves origin when a human edits or removes an agent comment", () => {
    const edit = commentPatches(
      { "main.tex": [agent] },
      { "main.tex": [{ ...agent, text: "Human edit" }] },
    )[0];
    expect(edit.after?.origin).toEqual(agent.origin);
    const removal = commentPatches({ "main.tex": [agent] }, {})[0];
    expect(removal.before?.origin).toEqual(agent.origin);
    expect(removal.after).toBeNull();
  });
  it("keeps saves ordered around an intervening path operation", async () => {
    const root = "/ordered-exit";
    let release!: () => void;
    const order: string[] = [];
    vi.mocked(invoke)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementation(async () => {
        order.push("later save");
      });
    const first = saveProjectInlineComments(root, {}, { "main.tex": [human] });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const mutation = withCommentPathMutation(root, async () => {
      order.push("path operation");
      return {};
    });
    const next = saveProjectInlineComments(
      root,
      { "main.tex": [human] },
      { "main.tex": [{ ...human, text: "Later" }] },
    );
    release();
    await Promise.all([first, mutation, next]);
    expect(order).toEqual(["path operation", "later save"]);
  });
  it("reports unique unsaved files and removes only completed files", async () => {
    const root = "/progress-files";
    let release!: () => void;
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (_cmd, args) => {
      const patch = args?.patch as { id: string };
      if (patch.id === human.id)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (patch.id === "last" && fail) throw new Error("Disk full");
    });
    const changed = vi.fn();
    window.addEventListener(COMMENT_SAVE_PROGRESS_EVENT, changed);
    try {
      const saving = saveProjectInlineComments(
        root,
        {},
        {
          "first.md": [human, agent],
          "second.md": [{ ...human, id: "last" }],
        },
      );
      const rejected = expect(saving).rejects.toThrow("Disk full");
      expect(getUnsavedCommentFiles(root)).toEqual(["first.md", "second.md"]);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      release();
      await rejected;
      expect(getUnsavedCommentFiles(root)).toEqual(["second.md"]);
      expect(changed).toHaveBeenCalled();
      fail = false;
      await flushProjectCommentWrites(root);
      expect(getUnsavedCommentFiles(root)).toEqual([]);
    } finally {
      window.removeEventListener(COMMENT_SAVE_PROGRESS_EVENT, changed);
    }
  });

  it("retries only unfinished patches after a partial failure", async () => {
    const root = "/partial-exit";
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Disk full"));
    await expect(
      saveProjectInlineComments(root, { "main.tex": [human, agent] }, {}),
    ).rejects.toThrow("Disk full");
    vi.mocked(invoke).mockResolvedValue(undefined);
    await flushProjectCommentWrites(root);
    const ids = vi
      .mocked(invoke)
      .mock.calls.map(([, args]) => (args?.patch as { id: string }).id);
    expect(ids).toEqual(["human", "agent", "agent"]);
  });
  it("serializes rapid edits and reports write failures", async () => {
    let release!: () => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = saveProjectInlineComments(
      "/serial",
      {},
      { "main.tex": [human] },
    );
    const next = saveProjectInlineComments(
      "/serial",
      { "main.tex": [human] },
      { "main.tex": [{ ...human, text: "Next" }] },
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, next]);
    expect(invoke).toHaveBeenCalledTimes(2);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("comment_conflict"));
    await expect(
      saveProjectInlineComments("/serial", { "main.tex": [human] }, {}),
    ).rejects.toThrow("comment_conflict");
  });
  it("merges remote additions and anchor moves without replacing unsaved text", () => {
    const local = { ...human, text: "Unsaved edit", isEditing: true };
    const added = applyCommentPatch(
      { "main.tex": [local] },
      { filePath: "main.tex", id: agent.id, before: null, after: agent },
    );
    expect(added["main.tex"]).toEqual([local, agent]);
    const moved = applyCommentPatch(added, {
      filePath: "main.tex",
      id: human.id,
      before: human,
      after: { ...human, from: 10, to: 14 },
    });
    expect(moved["main.tex"][0]).toEqual({ ...local, from: 10, to: 14 });
    const removed = applyCommentPatch(moved, {
      filePath: "main.tex",
      id: agent.id,
      before: agent,
      after: null,
    });
    expect(removed["main.tex"]).toHaveLength(1);
  });
  it("treats backend field ordering as equivalent", () => {
    const reordered = {
      text: human.text,
      line: human.line,
      to: human.to,
      from: human.from,
      id: human.id,
    };
    expect(
      commentPatches({ "main.tex": [human] }, { "main.tex": [reordered] }),
    ).toEqual([]);
    expect(
      applyCommentPatch(
        { "main.tex": [human] },
        { filePath: "main.tex", id: human.id, before: reordered, after: null },
      )["main.tex"],
    ).toEqual([]);
  });
});

it("keeps draft history metadata out of the native replay payload", async () => {
  const patch = {
    filePath: "main.tex",
    id: human.id,
    before: human,
    after: { ...human, text: "Edited" },
    draft: { before: { comment: human, text: "Unsaved" }, after: null },
  };
  vi.mocked(invoke).mockResolvedValue({
    filePath: patch.filePath,
    id: patch.id,
    before: patch.before,
    after: patch.after,
  });
  await replayProjectComment("/project", patch);
  const payload = vi.mocked(invoke).mock.calls[0][1] as {
    patch: Record<string, unknown>;
  };
  expect(Object.keys(payload.patch).sort()).toEqual([
    "after",
    "before",
    "filePath",
    "id",
  ]);
});

describe("versioned anchor recovery", () => {
  it("uses the captured source revision instead of trusting a later external replacement", async () => {
    const { readTextFile } = await import("@/lib/desktop/fs");
    const source = "before target after";
    const revision = createHash("sha1").update(source).digest("hex");
    const comment = { ...human, from: 7, to: 13, anchorRevision: revision };
    vi.mocked(readTextFile)
      .mockClear()
      .mockResolvedValue("unrelated replacement");
    vi.mocked(invoke).mockResolvedValue({
      files: { "main.tex": [comment] },
      sources: { [revision]: source },
      documents: { "main.tex": revision },
    });
    expect(await loadProjectInlineComments("/captured-source")).toEqual({
      "main.tex": [comment],
    });
    expect(readTextFile).not.toHaveBeenCalled();
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      "read_project_comments_anchored",
    ]);
    vi.mocked(readTextFile).mockReset();
  });

  it("restarts recovery if typing changes the buffer while its hash is pending", async () => {
    const { webcrypto } = await import("node:crypto");
    vi.stubGlobal("crypto", webcrypto);
    const root = "/buffer-changed-during-hash";
    dirtyBuffer(root, " text");
    const revision = createHash("sha1").update("text").digest("hex");
    const comment = { ...human, anchorRevision: revision };
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "read_project_comments_anchored"
        ? {
            files: { "main.tex": [comment] },
            sources: { [revision]: "text" },
            documents: { "main.tex": revision },
          }
        : args?.patch,
    );
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    let release!: () => void;
    const hashing = vi
      .spyOn(webcrypto.subtle, "digest")
      .mockImplementationOnce(async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return digest(...args);
      });
    try {
      const loading = loadProjectInlineComments(root);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      dirtyBuffer(root, "  text");
      release();
      expect((await loading)["main.tex"][0]).toMatchObject({ from: 2, to: 6 });
      const calls = vi.mocked(invoke).mock.calls;
      expect(
        calls.filter(([cmd]) => cmd === "read_project_comments_anchored"),
      ).toHaveLength(2);
      expect(
        calls
          .filter(([cmd]) => cmd === "update_project_comment_anchored")
          .map(([, args]) => args?.source),
      ).toEqual(["  text"]);
    } finally {
      release?.();
      hashing.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    "database",
    "buffer hash",
  ])("restarts a refresh superseded while awaiting its %s read", async (pause) => {
    const { webcrypto } = await import("node:crypto");
    vi.stubGlobal("crypto", webcrypto);
    const root = `/refresh-during-typing-${pause}`;
    dirtyBuffer(root, "xxtext");
    const original = { ...human, anchorRevision: "old" };
    let stored = original;
    let sources: Record<string, string> = { old: "text" };
    let release!: () => void;
    let waiting = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    let firstHash = true;
    const hashing = vi
      .spyOn(webcrypto.subtle, "digest")
      .mockImplementation(async (...args) => {
        if (pause === "buffer hash" && firstHash) {
          firstHash = false;
          waiting = true;
          await gate;
        }
        return digest(...args);
      });
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === "read_project_comments_anchored") {
        reads++;
        const snapshot = {
          files: { "main.tex": [stored] },
          sources: { ...sources },
        };
        if (pause === "database" && reads === 1) {
          waiting = true;
          await gate;
        }
        return snapshot;
      }
      if (command === "update_project_comment_anchored") {
        stored = args.patch.after;
        sources = { [stored.anchorRevision]: args.source };
        return args.patch;
      }
    });
    try {
      const refreshing = loadProjectInlineComments(root);
      await vi.waitFor(() => expect(waiting).toBe(true));
      await saveProjectInlineComments(
        root,
        { "main.tex": [original] },
        { "main.tex": [{ ...original, from: 2, to: 6 }] },
        { "main.tex": "xxtext" },
      );
      release();
      expect((await refreshing)["main.tex"][0]).toEqual(stored);
      expect(reads).toBe(2);
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(
            ([command]) => command === "update_project_comment_anchored",
          ),
      ).toHaveLength(1);
    } finally {
      release();
      hashing.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("maps unopened-file comments to saved text and does not map twice on reopening", async () => {
    const { readTextFile } = await import("@/lib/desktop/fs");
    const { webcrypto } = await import("node:crypto");
    vi.stubGlobal("crypto", webcrypto);
    const before = "alpha beta gamma";
    const after = "Intro\nalpha beta gamma";
    const revision = createHash("sha1").update(after).digest("hex");
    let comment = { ...human, from: 6, to: 10, anchorRevision: "old" };
    let sources: Record<string, string> = { old: before };
    vi.mocked(readTextFile).mockResolvedValue(after);
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === "read_project_comments_anchored")
        return {
          files: { "unopened.tex": [comment] },
          sources: { ...sources, [revision]: after },
          documents: { "unopened.tex": revision },
        };
      if (command === "update_project_comment_anchored") {
        comment = args.patch.after;
        sources = { [comment.anchorRevision]: args.source };
      }
    });
    const first = await loadProjectInlineComments("/recovery");
    expect(first["unopened.tex"][0]).toMatchObject({
      from: 12,
      to: 16,
      line: 2,
    });
    const writes = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([name]) => name === "update_project_comment_anchored",
      ).length;
    expect(await loadProjectInlineComments("/recovery")).toEqual(first);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([name]) => name === "update_project_comment_anchored",
        ),
    ).toHaveLength(writes);
    vi.mocked(readTextFile).mockReset();
    vi.unstubAllGlobals();
  });

  it("uses a point fallback when the reference is missing and retries after a failed metadata save", async () => {
    const { readTextFile } = await import("@/lib/desktop/fs");
    const { webcrypto } = await import("node:crypto");
    vi.stubGlobal("crypto", webcrypto);
    vi.mocked(readTextFile).mockResolvedValue("short");
    const original = {
      ...agent,
      from: 500,
      to: 510,
      anchorRevision: "missing",
    };
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "read_project_comments_anchored")
        return {
          files: { "main.tex": [original] },
          sources: { saved: "short" },
          documents: { "main.tex": "saved" },
        };
      if (command === "update_project_comment_anchored" && fail)
        throw new Error("Comment storage unavailable");
    });
    const first = await loadProjectInlineComments("/recovery-failure");
    expect(first["main.tex"][0]).toMatchObject({
      text: original.text,
      from: 5,
      to: 5,
      positionReset: true,
    });
    expect(original.from).toBe(500);
    fail = false;
    expect(await loadProjectInlineComments("/recovery-failure")).toEqual(first);
    vi.mocked(readTextFile).mockReset();
    vi.unstubAllGlobals();
  });
});

it("clears after queued writes and prevents stale snapshots from recreating that author", async () => {
  const root = "/clear-queued";
  let release!: () => void;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "update_project_comment")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return undefined;
  });
  const save = saveProjectInlineComments(root, {}, { "main.tex": [human] });
  await vi.waitFor(() => expect(release).toBeDefined());
  const clear = clearProjectComments(root, false);
  await saveProjectInlineComments(root, {}, { "main.tex": [human] });
  expect(vi.mocked(invoke).mock.calls.map((call) => call[0])).toEqual([
    "update_project_comment",
  ]);
  release();
  await Promise.all([save, clear]);
  expect(vi.mocked(invoke).mock.calls.map((call) => call[0])).toEqual([
    "update_project_comment",
    "clear_project_comments",
  ]);
  expect(wasCommentCleared(root, human.id)).toBe(true);
  await saveProjectInlineComments(root, {}, { "main.tex": [human] });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("a failed reset does not invalidate existing comments", async () => {
  const root = "/clear-failed";
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Permission denied"));
  await expect(clearProjectComments(root, false)).rejects.toThrow(
    "Permission denied",
  );
  expect(wasCommentCleared(root, human.id)).toBe(false);
  vi.mocked(invoke).mockResolvedValue(undefined);
  await saveProjectInlineComments(root, {}, { "main.tex": [human] });
  expect(invoke).toHaveBeenLastCalledWith(
    "update_project_comment",
    expect.anything(),
  );
});

describe("history rewind boundary", () => {
  it("rejects new writes during restore and allows restored cleared IDs", async () => {
    const {
      restoreWithProjectComments,
      notifyCommentsCleared,
      rememberComment,
      COMMENTS_RESTORED_EVENT,
    } = await import("./inline-comment-storage");
    const root = "/history-boundary";
    rememberComment(root, human);
    notifyCommentsCleared(root, false);
    expect(wasCommentCleared(root, human.id)).toBe(true);
    let finish!: () => void;
    const restore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const event = vi.fn();
    window.addEventListener(COMMENTS_RESTORED_EVENT, event);
    const operation = restoreWithProjectComments(root, restore);
    await vi.waitFor(() => expect(restore).toHaveBeenCalled());
    await expect(
      saveProjectInlineComments(root, {}, { "main.tex": [human] }),
    ).rejects.toThrow("History is being restored");
    await expect(
      replayProjectComment(root, {
        filePath: "main.tex",
        id: human.id,
        before: null,
        after: human,
      }),
    ).rejects.toThrow("History is being restored");
    finish();
    await operation;
    expect(wasCommentCleared(root, human.id)).toBe(false);
    expect(event).toHaveBeenCalledTimes(1);
    window.removeEventListener(COMMENTS_RESTORED_EVENT, event);
  });
});

it("a failed rewind keeps the existing comment timeline", async () => {
  const {
    restoreWithProjectComments,
    notifyCommentsCleared,
    rememberComment,
    COMMENTS_RESTORED_EVENT,
  } = await import("./inline-comment-storage");
  const root = "/failed-history-boundary";
  rememberComment(root, human);
  notifyCommentsCleared(root, false);
  const event = vi.fn();
  window.addEventListener(COMMENTS_RESTORED_EVENT, event);
  try {
    await expect(
      restoreWithProjectComments(root, async () => {
        throw new Error("Source save failed");
      }),
    ).rejects.toThrow("Source save failed");
    expect(wasCommentCleared(root, human.id)).toBe(true);
    expect(event).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(COMMENTS_RESTORED_EVENT, event);
  }
});

describe("comment path mutations", () => {
  it("drains older writes and retargets later writes and undo by comment identity", async () => {
    const { withCommentPathMutation } = await import(
      "./inline-comment-storage"
    );
    const { clearCommentPaths } = await import("./comment-paths");
    const root = "/rename-queue";
    clearCommentPaths(root);
    let release!: () => void;
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "update_project_comment")
        order.push((args!.patch as { filePath: string }).filePath);
      if (command === "replay_project_comment") return args!.patch;
    });
    await saveProjectInlineComments(root, {}, { "old.md": [human, agent] });
    const moving = withCommentPathMutation(root, async () => {
      reached();
      await delayed;
      return { pathChanges: [{ oldPath: "old.md", newPath: "new.md" }] };
    });
    await started;
    const edited = { ...human, text: "Edited while rename waits" };
    const writing = saveProjectInlineComments(
      root,
      { "old.md": [human] },
      { "old.md": [edited] },
    );
    expect(order).toEqual(["old.md", "old.md"]);
    release();
    await moving;
    await writing;
    expect(order).toEqual(["old.md", "old.md", "new.md"]);
    await replayProjectComment(root, {
      filePath: "old.md",
      id: human.id,
      before: edited,
      after: human,
    });
    expect(invoke).toHaveBeenLastCalledWith(
      "replay_project_comment",
      expect.objectContaining({
        patch: expect.objectContaining({ filePath: "new.md" }),
      }),
    );
    // A different comment created at a reused old name keeps its own identity.
    await saveProjectInlineComments(
      root,
      {},
      { "old.md": [{ ...human, id: "new-file-comment" }] },
    );
    expect(order[order.length - 1]).toBe("old.md");
  });
  it("keeps draft text and folder descendants through a path change", async () => {
    const { publishCommentPathChanges } = await import(
      "./inline-comment-storage"
    );
    const { setCommentDraft, getCommentDraft } = await import(
      "./comment-draft-history"
    );
    const root = "/rename-drafts";
    setCommentDraft({ root, filePath: "old/chapter.md" }, human.id, {
      comment: human,
      text: "Unsubmitted text",
    });
    publishCommentPathChanges(root, [
      { oldPath: "old", newPath: "new", folder: true },
    ]);
    expect(
      getCommentDraft({ root, filePath: "new/chapter.md" }, human.id)?.text,
    ).toBe("Unsubmitted text");
    expect(
      getCommentDraft({ root, filePath: "old/chapter.md" }, human.id),
    ).toBeUndefined();
  });
  it("does not move comments when the source rename fails", async () => {
    const { withCommentPathMutation } = await import(
      "./inline-comment-storage"
    );
    const { resolveCommentPath, trackCommentPath } = await import(
      "./comment-paths"
    );
    const root = "/failed-rename";
    trackCommentPath(root, human.id, "old.md");
    await expect(
      withCommentPathMutation(root, async () => {
        throw new Error("Permission denied");
      }),
    ).rejects.toThrow("Permission denied");
    expect(resolveCommentPath(root, human.id, "fallback")).toBe("old.md");
  });
  it("keeps archived drafts detached when the same filename is reused", async () => {
    const { setCommentDraft, projectCommentDrafts } = await import(
      "./comment-draft-history"
    );
    const root = "/orphaned-draft";
    setCommentDraft({ root, filePath: "old.md" }, human.id, {
      comment: human,
      text: "Unsubmitted edit",
    });
    vi.mocked(invoke).mockResolvedValue({
      files: {},
      sources: {},
      orphanedPaths: ["old.md"],
      orphanedIds: [human.id],
    });
    await loadProjectInlineComments(root);
    expect(projectCommentDrafts(root, {})).toEqual({});
    setCommentDraft({ root, filePath: "old.md" }, "replacement-comment", {
      comment: { ...human, id: "replacement-comment" },
      text: "New file comment",
    });
    expect(
      projectCommentDrafts(root, {})["old.md"].map((comment) => comment.id),
    ).toEqual(["replacement-comment"]);
  });
});

it("retains failed undo and ordered redo until storage recovers", async () => {
  const root = "/replay-storage-retry";
  const patch = {
    filePath: "main.tex",
    id: human.id,
    before: human,
    after: { ...human, text: "Undone" },
  };
  const applied = vi.fn();
  vi.mocked(invoke).mockRejectedValue(new Error("disk unavailable"));
  await expect(replayProjectComment(root, patch, applied)).rejects.toThrow(
    "disk unavailable",
  );
  await expect(
    replayProjectComment(
      root,
      { ...patch, before: patch.after, after: human },
      applied,
    ),
  ).rejects.toThrow();
  expect(applied).not.toHaveBeenCalled();
  expect(getUnsavedCommentFiles(root)).toEqual(["main.tex"]);
  const writes: string[] = [];
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const value = args!.patch as typeof patch;
    writes.push(value.after.text);
    return value;
  });
  await flushProjectCommentWrites(root);
  expect(writes).toEqual(["Undone", "Clarify"]);
  expect(applied).toHaveBeenCalledTimes(2);
  expect(getUnsavedCommentFiles(root)).toEqual([]);
  await flushProjectCommentWrites(root);
  expect(applied).toHaveBeenCalledTimes(2);
});

it("skips an orphan detected by the backend without retaining a failed save", async () => {
  const root = "/replay-orphan";
  vi.mocked(invoke).mockRejectedValue(
    new Error("comment_orphaned: file replaced"),
  );
  const applied = vi.fn();
  expect(
    await replayProjectComment(
      root,
      { filePath: "main.tex", id: human.id, before: human, after: null },
      applied,
    ),
  ).toBeNull();
  expect(applied).not.toHaveBeenCalled();
  expect(getUnsavedCommentFiles(root)).toEqual([]);
});

it("skips a retained replay explicitly cleared before retry", async () => {
  const root = "/replay-cleared";
  const { rememberComment, notifyCommentsCleared } = await import(
    "./inline-comment-storage"
  );
  rememberComment(root, human);
  vi.mocked(invoke).mockRejectedValue(new Error("disk unavailable"));
  await expect(
    replayProjectComment(root, {
      filePath: "main.tex",
      id: human.id,
      before: human,
      after: null,
    }),
  ).rejects.toThrow();
  notifyCommentsCleared(root, false);
  const count = vi.mocked(invoke).mock.calls.length;
  await flushProjectCommentWrites(root);
  expect(invoke).toHaveBeenCalledTimes(count);
  expect(getUnsavedCommentFiles(root)).toEqual([]);
});

it("does not retain an incompatible inverse after reconnection", async () => {
  const root = "/replay-conflict";
  vi.mocked(invoke).mockRejectedValue(
    new Error("comment_conflict: this comment changed since that action"),
  );
  expect(
    await replayProjectComment(root, {
      filePath: "main.tex",
      id: human.id,
      before: human,
      after: null,
    }),
  ).toBeNull();
  expect(getUnsavedCommentFiles(root)).toEqual([]);
  await flushProjectCommentWrites(root);
});

it("keeps draft-only replay ordered behind a failed persisted replay", async () => {
  const root = "/replay-draft-order";
  const seen: string[] = [];
  vi.mocked(invoke).mockRejectedValue(new Error("disk unavailable"));
  await expect(
    replayProjectComment(
      root,
      { filePath: "main.tex", id: human.id, before: human, after: null },
      () => seen.push("persisted"),
    ),
  ).rejects.toThrow();
  await expect(
    replayProjectComment(
      root,
      {
        filePath: "main.tex",
        id: human.id,
        before: null,
        after: null,
        draftOnly: true,
      },
      () => seen.push("draft"),
    ),
  ).rejects.toThrow();
  expect(seen).toEqual([]);
  vi.mocked(invoke).mockImplementation(async (_command, args) => args!.patch);
  const count = vi.mocked(invoke).mock.calls.length;
  await flushProjectCommentWrites(root);
  expect(seen).toEqual(["persisted", "draft"]);
  expect(invoke).toHaveBeenCalledTimes(count + 1);
});

it("refreshes pending-file observers after a replay finishes", async () => {
  const root = "/replay-progress";
  const states: string[][] = [];
  const observe = (event: Event) => {
    if ((event as CustomEvent<string>).detail === root)
      states.push(getUnsavedCommentFiles(root));
  };
  window.addEventListener(COMMENT_SAVE_PROGRESS_EVENT, observe);
  try {
    vi.mocked(invoke).mockImplementation(async (_command, args) => args!.patch);
    await replayProjectComment(root, {
      filePath: "main.tex",
      id: human.id,
      before: human,
      after: null,
    });
    expect(states[0]).toEqual(["main.tex"]);
    expect(states[states.length - 1]).toEqual([]);
  } finally {
    window.removeEventListener(COMMENT_SAVE_PROGRESS_EVENT, observe);
  }
});

it("does not let an obsolete anchor update block disconnected-comment recovery", async () => {
  const root = "/external-anchor-disconnected";
  vi.mocked(invoke).mockRejectedValueOnce(
    new Error("comment_orphaned: preserved"),
  );
  await saveProjectInlineComments(
    root,
    { "main.tex": [human] },
    { "main.tex": [{ ...human, from: 2, to: 6 }] },
  );
  await flushProjectCommentWrites(root);
  expect(getUnsavedCommentFiles(root)).toEqual([]);
  // Actual user feedback edits are retained for retry, never silently dropped.
  vi.mocked(invoke).mockRejectedValueOnce(
    new Error("comment_orphaned: preserved"),
  );
  await expect(
    saveProjectInlineComments(
      root,
      { "main.tex": [human] },
      { "main.tex": [{ ...human, text: "Unsaved feedback" }] },
    ),
  ).rejects.toThrow("comment_orphaned");
  expect(getUnsavedCommentFiles(root)).toEqual(["main.tex"]);
  vi.mocked(invoke).mockResolvedValue({});
  await flushProjectCommentWrites(root);
});

it("drains superseded anchor batches without dropping feedback edits", async () => {
  const { webcrypto } = await import("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
  const root = "/recovered-anchor-queue";
  try {
    const before = [human, { ...human, id: "second" }];
    const after = before.map((c) => ({ ...c, from: 2, to: 6 }));
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("comment_anchor_superseded: recovered"))
      .mockRejectedValueOnce(new Error("comment_anchor_superseded: recovered"))
      .mockRejectedValueOnce(new Error("comment_anchor_superseded: recovered"));
    await saveProjectInlineComments(
      root,
      { "main.tex": before },
      { "main.tex": after },
      { "main.tex": "new source" },
    );
    await flushProjectCommentWrites(root);
    expect(getUnsavedCommentFiles(root)).toEqual([]);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      "update_project_comment_anchors",
      "update_project_comment_anchored",
      "update_project_comment_anchored",
    ]);
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("comment_conflict: feedback changed"),
    );
    await expect(
      saveProjectInlineComments(
        root,
        { "main.tex": [human] },
        { "main.tex": [{ ...human, text: "Keep this feedback" }] },
      ),
    ).rejects.toThrow("comment_conflict:");
    expect(getUnsavedCommentFiles(root)).toEqual(["main.tex"]);
    vi.mocked(invoke).mockResolvedValue({});
    await flushProjectCommentWrites(root);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("batches many anchor shifts with one source snapshot and retries failed transactions", async () => {
  const { webcrypto } = await import("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
  try {
    const project = "/many-anchors";
    const comments = Array.from({ length: 1000 }, (_, index) => ({
      ...human,
      id: `many-${index}`,
    }));
    const shifted = comments.map((comment) => ({ ...comment, from: 1, to: 5 }));
    vi.mocked(invoke).mockRejectedValueOnce(new Error("write failed"));
    await expect(
      saveProjectInlineComments(
        project,
        { "main.tex": comments },
        { "main.tex": shifted },
        { "main.tex": " text" },
      ),
    ).rejects.toThrow("write failed");
    expect(getUnsavedCommentFiles(project)).toEqual(["main.tex"]);
    vi.mocked(invoke).mockResolvedValue({ orphanedIds: [] });
    await flushProjectCommentWrites(project);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      "update_project_comment_anchors",
      "update_project_comment_anchors",
    ]);
    const args = vi.mocked(invoke).mock.calls[1][1] as any;
    expect(args.patches).toHaveLength(1000);
    expect(
      new Set(args.patches.map((patch: any) => patch.after.anchorRevision))
        .size,
    ).toBe(1);
    expect(args.source).toBe(" text");
    expect(getUnsavedCommentFiles(project)).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("merges batch notifications using the same conflict rules as individual events", () => {
  const files = { "main.tex": [human, agent] };
  const patches = commentPatches(files, {
    "main.tex": [
      { ...human, from: 1, to: 5 },
      { ...agent, resolved: true },
    ],
  });
  const concurrent = {
    "main.tex": [{ ...human, text: "Newer feedback" }, agent],
  };
  expect(applyCommentPatches(concurrent, patches)).toEqual(
    patches.reduce(applyCommentPatch, concurrent),
  );
  const removal = commentPatches(files, { "main.tex": [agent] });
  expect(applyCommentPatches(files, [...removal, ...patches])).toEqual(
    [...removal, ...patches].reduce(applyCommentPatch, files),
  );
});

it("coalesces only untouched consecutive anchor jobs, keeping the oldest baseline and latest source", async () => {
  const { webcrypto } = await import("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
  try {
    const root = "/coalesced-typing";
    let release!: () => void;
    vi.mocked(invoke).mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const blocked = saveProjectInlineComments(
      root,
      {},
      { "other.tex": [{ ...human, id: "block" }] },
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    vi.mocked(invoke).mockResolvedValue({ orphanedIds: [] });
    const original = [human, agent];
    const middle = original.map((c) => ({ ...c, from: 1, to: 5 }));
    const latest = original.map((c) => ({ ...c, from: 2, to: 6 }));
    const first = saveProjectInlineComments(
      root,
      { "main.tex": original },
      { "main.tex": middle },
      { "main.tex": " text" },
    );
    const second = saveProjectInlineComments(
      root,
      { "main.tex": middle },
      { "main.tex": latest },
      { "main.tex": "  text" },
    );
    release();
    await Promise.all([blocked, first, second]);
    const writes = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) => command === "update_project_comment_anchors",
      );
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({
      source: "  text",
      patches: [
        { before: { from: 0, to: 4 }, after: { from: 2, to: 6 } },
        { before: { from: 0, to: 4 }, after: { from: 2, to: 6 } },
      ],
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("does not coalesce anchor saves across a file operation", async () => {
  const { webcrypto } = await import("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
  try {
    const root = "/typing-barrier";
    let release!: () => void;
    const order: string[] = [];
    vi.mocked(invoke).mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const blocked = saveProjectInlineComments(
      root,
      {},
      { "other.tex": [{ ...human, id: "barrier-block" }] },
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    vi.mocked(invoke).mockImplementation(async (command) => {
      order.push(command);
      return { orphanedIds: [] };
    });
    const original = [human, agent];
    const middle = original.map((c) => ({ ...c, from: 1, to: 5 }));
    const latest = original.map((c) => ({ ...c, from: 2, to: 6 }));
    const first = saveProjectInlineComments(
      root,
      { "main.tex": original },
      { "main.tex": middle },
      { "main.tex": " text" },
    );
    const mutation = withCommentPathMutation(root, async () => {
      order.push("file-operation");
      return {};
    });
    const second = saveProjectInlineComments(
      root,
      { "main.tex": middle },
      { "main.tex": latest },
      { "main.tex": "  text" },
    );
    release();
    await Promise.all([blocked, first, mutation, second]);
    expect(order).toEqual([
      "update_project_comment_anchors",
      "file-operation",
      "update_project_comment_anchors",
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps a failed anchor batch unchanged when newer typing arrives", async () => {
  const { webcrypto } = await import("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
  try {
    const root = "/failed-anchor-batch";
    vi.mocked(invoke).mockRejectedValueOnce(new Error("write failed"));
    const original = [human, agent];
    const middle = original.map((c) => ({ ...c, from: 1, to: 5 }));
    const latest = original.map((c) => ({ ...c, from: 2, to: 6 }));
    await expect(
      saveProjectInlineComments(
        root,
        { "main.tex": original },
        { "main.tex": middle },
        { "main.tex": " text" },
      ),
    ).rejects.toThrow("write failed");
    vi.mocked(invoke).mockResolvedValue({ orphanedIds: [] });
    await saveProjectInlineComments(
      root,
      { "main.tex": middle },
      { "main.tex": latest },
      { "main.tex": "  text" },
    );
    const writes = vi.mocked(invoke).mock.calls.map(([, args]) => args as any);
    expect(writes.map((args) => args.source)).toEqual([
      " text",
      " text",
      "  text",
    ]);
    expect(writes[1]).toEqual(writes[0]);
    expect(getUnsavedCommentFiles(root)).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps CRLF and Unicode offsets when reusing source indices during loading", async () => {
  const { readTextFile } = await import("@/lib/desktop/fs");
  const { webcrypto } = await import("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
  try {
    const source = "first\r\n😀last";
    const next = "Intro\r\n" + source;
    vi.mocked(readTextFile).mockResolvedValue(next);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "read_project_comments_anchored")
        return {
          files: {
            "main.tex": [
              { ...human, from: 7, to: 9, line: 2, anchorRevision: "old" },
            ],
          },
          sources: { old: source, saved: next },
          documents: { "main.tex": "saved" },
        };
      return { orphanedIds: [] };
    });
    const files = await loadProjectInlineComments("/crlf-indices");
    expect(files["main.tex"][0]).toMatchObject({ from: 14, to: 16, line: 3 });
  } finally {
    vi.mocked(readTextFile).mockReset();
    vi.unstubAllGlobals();
  }
});

it("replays one source operation for a thousand comments when loading a dirty file", async () => {
  const { readTextFile } = await import("@/lib/desktop/fs");
  const { webcrypto } = await import("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
  const fork = vi.spyOn(DocumentModel.prototype, "fork");
  try {
    const source = "source line\n".repeat(20_000);
    dirtyBuffer("/batch-load", `intro\n${source}`);
    const comments = Array.from({ length: 1000 }, (_, i) => ({
      ...human,
      id: `load-${i}`,
      from: i * 12,
      to: i * 12 + 6,
      line: i + 1,
      resolved: i % 2 === 0,
      anchorRevision: "load-basis",
    }));
    vi.mocked(readTextFile).mockResolvedValue(`intro\n${source}`);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "read_project_comments_anchored")
        return {
          files: { "main.tex": comments },
          sources: { "load-basis": source },
        };
      return { orphanedIds: [] };
    });
    const files = await loadProjectInlineComments("/batch-load");
    expect(fork).toHaveBeenCalledTimes(1);
    expect(files["main.tex"]).toHaveLength(1000);
    for (const [i, comment] of files["main.tex"].entries()) {
      expect(comment).toMatchObject({
        from: i * 12 + 6,
        to: i * 12 + 12,
        line: i + 2,
        resolved: i % 2 === 0,
      });
    }
  } finally {
    fork.mockRestore();
    vi.mocked(readTextFile).mockReset();
    vi.unstubAllGlobals();
  }
});

it("carries a delayed first-save acknowledgement into an already queued delete", async () => {
  const root = "/fast-create-delete";
  let release!: () => void;
  const saved = { ...human, number: 17, anchorRevision: "saved-source" };
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const patch =
      args?.patch as import("./inline-comment-storage").CommentPatch;
    if (!patch.before) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...patch, after: saved };
    }
    expect(patch.before).toEqual(saved);
    expect(patch.after).toBeNull();
    return { ...patch, before: saved };
  });
  const created = saveProjectInlineComments(root, {}, { "main.tex": [human] });
  expect(isCommentSaving(root, human.id)).toBe(true);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const deleted = saveProjectInlineComments(root, { "main.tex": [human] }, {});
  // Attach rejection handlers before releasing the first operation.
  const settled = Promise.allSettled([created, deleted]);
  release();
  expect(await settled).toEqual([
    { status: "fulfilled", value: undefined },
    { status: "fulfilled", value: undefined },
  ]);
  expect(getUnsavedCommentFiles(root)).toEqual([]);
  expect(isCommentSaving(root, human.id)).toBe(false);
});

it("retains the first saved source revision without replacing a newer local range", () => {
  const saved = { ...human, number: 9, anchorRevision: "first" };
  const patch = {
    filePath: "main.tex",
    id: human.id,
    before: null,
    after: saved,
  };
  expect(
    applyCommentPatch({ "main.tex": [human] }, patch)["main.tex"][0],
  ).toEqual(saved);
  const moved = { ...human, from: 2, to: 6, anchorRevision: "newer" };
  expect(
    applyCommentPatch({ "main.tex": [moved] }, patch)["main.tex"][0],
  ).toEqual({ ...moved, number: 9 });
});

it("carries acknowledgements through queued create, edit, resolve, and delete", async () => {
  const root = "/fast-create-edit-delete";
  let release!: () => void;
  let disk: InlineEditorComment | null = null;
  vi.mocked(invoke).mockImplementation(async (_cmd, args) => {
    const patch =
      args?.patch as import("./inline-comment-storage").CommentPatch;
    if (!patch.before)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    else expect(patch.before).toEqual(disk);
    const before = disk;
    disk = patch.after
      ? { ...patch.after, number: 3, anchorRevision: "persisted" }
      : null;
    return { ...patch, before, after: disk };
  });
  const edited = { ...human, text: "Edited" };
  const resolved = { ...edited, resolved: true };
  const jobs = [saveProjectInlineComments(root, {}, { "main.tex": [human] })];
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  jobs.push(
    saveProjectInlineComments(
      root,
      { "main.tex": [human] },
      { "main.tex": [edited] },
    ),
  );
  jobs.push(
    saveProjectInlineComments(
      root,
      { "main.tex": [edited] },
      { "main.tex": [resolved] },
    ),
  );
  jobs.push(saveProjectInlineComments(root, { "main.tex": [resolved] }, {}));
  const settled = Promise.allSettled(jobs);
  release();
  expect((await settled).every((result) => result.status === "fulfilled")).toBe(
    true,
  );
  expect(disk).toBeNull();
  expect(getUnsavedCommentFiles(root)).toEqual([]);
});

it("does not bless concurrent content changes as permission for a queued delete", async () => {
  const root = "/concurrent-create-delete";
  let release!: () => void;
  vi.mocked(invoke).mockImplementation(async (_cmd, args) => {
    const patch =
      args?.patch as import("./inline-comment-storage").CommentPatch;
    if (!patch.before) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ...patch,
        after: {
          ...human,
          number: 1,
          anchorRevision: "other",
          text: "Changed elsewhere",
        },
      };
    }
    expect(patch.before?.text).toBe(human.text);
    expect(patch.before?.anchorRevision).toBeUndefined();
    throw new Error("comment_conflict");
  });
  const created = saveProjectInlineComments(root, {}, { "main.tex": [human] });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const deleted = saveProjectInlineComments(root, { "main.tex": [human] }, {});
  const settled = Promise.allSettled([created, deleted]);
  release();
  expect((await settled)[1].status).toBe("rejected");
  expect(getUnsavedCommentFiles(root)).toEqual(["main.tex"]);
  // Explicit retry remains possible; clean this isolated queue for other tests.
  vi.mocked(invoke).mockResolvedValue(undefined);
  await flushProjectCommentWrites(root);
});

it("updates a queued delete after a batched source-anchor save", async () => {
  const root = "/batch-before-delete";
  const a = { ...human, number: 1, anchorRevision: "old" };
  const b = { ...human, id: "other", number: 2, anchorRevision: "old" };
  const moved = [a, b].map((c) => ({ ...c, from: 1, to: 5 }));
  let release!: () => void;
  let revision = "";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "update_project_comment_anchors") {
      revision = (
        args?.patches as import("./inline-comment-storage").CommentPatch[]
      )[0].after!.anchorRevision!;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { orphanedIds: [] };
    }
    const patch =
      args?.patch as import("./inline-comment-storage").CommentPatch;
    expect(patch.before).toEqual({ ...moved[0], anchorRevision: revision });
    expect(patch.after).toBeNull();
    return patch;
  });
  const moving = saveProjectInlineComments(
    root,
    { "main.tex": [a, b] },
    { "main.tex": moved },
    { "main.tex": " text" },
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const deleting = saveProjectInlineComments(
    root,
    { "main.tex": moved },
    { "main.tex": [moved[1]] },
  );
  const settled = Promise.allSettled([moving, deleting]);
  release();
  expect((await settled).every((result) => result.status === "fulfilled")).toBe(
    true,
  );
  expect(getUnsavedCommentFiles(root)).toEqual([]);
});

describe("explicit conflict recovery", () => {
  it("identifies a failed anchor batch's conflicting record and preserves the others", async () => {
    const root = "/conflict-batch";
    const other = { ...human, id: "other" };
    const a = { ...human, from: 1, to: 5 };
    const b = { ...other, from: 1, to: 5 };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const patch = args?.patch as { id: string };
      if (
        command === "update_project_comment_anchors" ||
        patch?.id === human.id
      )
        throw new Error("comment_conflict: anchor changed");
      return args?.patch;
    });
    await expect(
      saveProjectInlineComments(
        root,
        { "main.tex": [human, other] },
        { "main.tex": [a, b] },
        { "main.tex": "0123456789" },
      ),
    ).rejects.toThrow("comment_conflict");
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "read_project_comments_anchored"
        ? { files: { "main.tex": [human, other] } }
        : args?.patch,
    );
    await resolveCommentSaveConflict(root, false);
    expect(invoke).toHaveBeenLastCalledWith(
      "update_project_comment_anchored",
      expect.objectContaining({
        patch: expect.objectContaining({
          id: "other",
          after: expect.objectContaining({ from: 1, to: 5 }),
        }),
      }),
    );
    expect(getUnsavedCommentFiles(root)).toEqual([]);
  });

  it("accepts disconnection without deleting the saved orphan", async () => {
    const root = "/conflict-orphan";
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("comment_orphaned: removed file"),
    );
    await expect(
      saveProjectInlineComments(
        root,
        { "main.tex": [human] },
        { "main.tex": [{ ...human, text: "Local" }] },
      ),
    ).rejects.toThrow();
    vi.mocked(invoke).mockResolvedValue({ files: {}, orphanedIds: [human.id] });
    await expect(resolveCommentSaveConflict(root, true)).rejects.toThrow(
      "disconnected",
    );
    const calls = vi.mocked(invoke).mock.calls.length;
    await resolveCommentSaveConflict(root, false);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.slice(calls)
        .map(([command]) => command),
    ).toEqual(["read_project_comments_anchored"]);
    expect(getUnsavedCommentFiles(root)).toEqual([]);
  });

  it("keeps local text while preserving independent remote status and coordinates", async () => {
    const root = "/conflict-keep";
    const local = { ...human, text: "Local" };
    const remote = {
      ...human,
      text: "Remote",
      resolved: true,
      from: 10,
      to: 14,
      anchorRevision: "remote",
    };
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("comment_conflict: changed"),
    );
    await expect(
      saveProjectInlineComments(
        root,
        { "main.tex": [human] },
        { "main.tex": [local] },
        { "main.tex": "original source" },
      ),
    ).rejects.toThrow("comment_conflict");
    vi.mocked(invoke).mockImplementation(
      async (command, args: Record<string, unknown> | undefined) =>
        command === "read_project_comments_anchored"
          ? { files: { "moved.tex": [remote] } }
          : args?.patch,
    );
    await resolveCommentSaveConflict(root, true);
    expect(invoke).toHaveBeenLastCalledWith("update_project_comment", {
      projectRoot: root,
      patch: {
        filePath: "moved.tex",
        id: human.id,
        before: remote,
        after: { ...remote, text: "Local" },
      },
    });
    expect(getUnsavedCommentFiles(root)).toEqual([]);
  });
  it("uses stored for the conflicted comment without losing unrelated queued writes", async () => {
    const root = "/conflict-stored";
    const local = { ...human, text: "Local" };
    const other = { ...human, id: "other", text: "Other" };
    vi.mocked(invoke).mockRejectedValue(new Error("comment_conflict: changed"));
    await expect(
      saveProjectInlineComments(
        root,
        { "main.tex": [human] },
        { "main.tex": [local] },
      ),
    ).rejects.toThrow();
    await expect(
      saveProjectInlineComments(
        root,
        { "main.tex": [local] },
        { "main.tex": [{ ...local, text: "Later" }, other] },
      ),
    ).rejects.toThrow();
    vi.mocked(invoke).mockImplementation(
      async (command, args: Record<string, unknown> | undefined) =>
        command === "read_project_comments_anchored"
          ? { files: {} }
          : args?.patch,
    );
    await resolveCommentSaveConflict(root, false);
    expect(invoke).toHaveBeenLastCalledWith(
      "update_project_comment",
      expect.objectContaining({
        patch: expect.objectContaining({ id: "other", after: other }),
      }),
    );
    expect(getUnsavedCommentFiles(root)).toEqual([]);
  });
  it("retains a second conflict if the stored version changes again during resolution", async () => {
    const root = "/conflict-again";
    const local = { ...human, text: "Local" };
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("comment_conflict: changed"),
    );
    await expect(
      saveProjectInlineComments(
        root,
        { "main.tex": [human] },
        { "main.tex": [local] },
      ),
    ).rejects.toThrow();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "read_project_comments_anchored")
        return { files: { "main.tex": [{ ...human, text: "Remote" }] } };
      throw new Error("comment_conflict: changed again");
    });
    await expect(resolveCommentSaveConflict(root, true)).rejects.toThrow(
      "changed again",
    );
    expect(getUnsavedCommentFiles(root)).toEqual(["main.tex"]);
    await resolveCommentSaveConflict(root, false);
    expect(getUnsavedCommentFiles(root)).toEqual([]);
  });
});

it("unlocks failed comment actions and marks them saving again during retry", async () => {
  const root = "/pending-ui-retry";
  let release!: () => void;
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Disk full"));
  await expect(
    saveProjectInlineComments(root, {}, { "main.tex": [human] }),
  ).rejects.toThrow("Disk full");
  expect(isCommentSaving(root, human.id)).toBe(false);
  expect(getUnsavedCommentFiles(root)).toEqual(["main.tex"]);
  vi.mocked(invoke).mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const retry = flushProjectCommentWrites(root);
  await vi.waitFor(() => expect(isCommentSaving(root, human.id)).toBe(true));
  expect(isCommentSaving(root, agent.id)).toBe(false);
  release();
  await retry;
  expect(isCommentSaving(root, human.id)).toBe(false);
});

it("does not publish saving UI for automatic anchor changes", async () => {
  const root = "/quiet-anchor-ui";
  const listener = vi.fn();
  const unsubscribe = subscribeCommentSaving(root, human.id, listener);
  vi.mocked(invoke).mockResolvedValue(undefined);
  try {
    await saveProjectInlineComments(
      root,
      { "main.tex": [human] },
      {
        "main.tex": [{ ...human, from: 2, to: 6 }],
      },
    );
    expect(listener).not.toHaveBeenCalled();
    expect(isCommentSaving(root, human.id)).toBe(false);
  } finally {
    unsubscribe();
  }
});
