import {
  buildCrossProviderTranscript,
  handoffMessageCount,
} from "../chat-transcript";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  forkSavedChat,
  cancelSavedFork,
  prepareSavedChatTurn,
  syncSavedChat,
  appendChatReviewDecision,
  includeChatReviewDecisions,
  loadChatCheckpoint,
  loadChatMessages,
  saveChatCheckpoint,
} from "./chat-checkpoints";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-checkpoint-"));
  directories.push(dir);
  await fs.mkdir(path.join(dir, "checkpoints"));
  return path.join(dir, "checkpoints");
}
it("repairs answered question metadata before restoring unloaded chats", async () => {
  const dir = await directory();
  const pendingQuestion = {
    requestId: "saved-question",
    projectRoot: "/project",
    question: "What next?",
    options: [],
  };
  // The answer is outside the latest history window and must not require
  // selecting the chat or loading its transcript into the renderer.
  const messages = [
    { type: "user", uuid: "question-answer-saved-question" },
    ...Array.from({ length: 300 }, (_, index) => ({
      type: "assistant",
      uuid: `reply-${index}`,
    })),
  ];
  await saveChatCheckpoint(dir, {
    version: 1,
    tabs: [
      { id: "answered", pendingQuestion, messages },
      {
        id: "unanswered",
        pendingQuestion: { ...pendingQuestion, requestId: "new-question" },
        messages,
      },
    ],
  });
  const restored = (await loadChatCheckpoint(dir))!;
  expect(restored.tabs[0]).toMatchObject({
    pendingQuestion: null,
    messages: [],
    history: { total: 301, start: 301 },
  });
  expect(restored.tabs[1].pendingQuestion).toEqual({
    ...pendingQuestion,
    requestId: "new-question",
  });
  await saveChatCheckpoint(dir, restored);
  expect((await loadChatCheckpoint(dir))?.tabs[0].pendingQuestion).toBeNull();
  expect(await loadChatMessages(dir, "answered", 0, 301)).toEqual(messages);
});
it("restores large chats, drafts and provider IDs without browser storage", async () => {
  const dir = await directory();
  expect(await loadChatCheckpoint(dir)).toBeNull();
  const snapshot = {
    version: 1 as const,
    activeTabId: "one",
    tabs: [
      {
        id: "one",
        messages: [{ text: "x".repeat(6 * 1024 * 1024) }],
        draft: "keep",
        providerSessionIds: { claude: "native" },
      },
      { id: "two", messages: [], pauseState: "paused" },
    ],
  };
  await saveChatCheckpoint(dir, snapshot);
  const loaded = await loadChatCheckpoint(dir);
  expect(loaded?.tabs[0].messages).toEqual([]);
  expect(await loadChatMessages(dir, "one", 0, 100)).toEqual(
    snapshot.tabs[0].messages,
  );
  const before = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
  );
  await saveChatCheckpoint(dir, {
    ...snapshot,
    tabs: [snapshot.tabs[0], { ...snapshot.tabs[1], draft: "changed" }],
  });
  const after = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
  );
  expect(after.tabs[0].file).toBe(before.tabs[0].file);
  expect(after.tabs[1].file).not.toBe(before.tabs[1].file);
});
it("retains the last checkpoint if a later save fails", async () => {
  const dir = await directory();
  const snapshot = {
    version: 1 as const,
    tabs: [{ id: "one", draft: "saved" }],
  };
  await saveChatCheckpoint(dir, snapshot);
  const circular: Record<string, unknown> = { id: "broken" };
  circular.self = circular;
  await expect(
    saveChatCheckpoint(dir, {
      version: 1,
      tabs: [{ id: "one", draft: "changed" }, circular as { id: string }],
    }),
  ).rejects.toThrow();
  expect(await loadChatCheckpoint(dir)).toMatchObject(snapshot);
});
it("does not treat corrupted checkpoints as empty history", async () => {
  const dir = await directory();
  await fs.writeFile(path.join(dir, "manifest.json"), "bad JSON");
  await expect(loadChatCheckpoint(dir)).rejects.toThrow();
});

it("reads bounded windows and preserves untouched chunks in incremental saves", async () => {
  const dir = await directory();
  const messages = Array.from({ length: 1000 }, (_, id) => ({
    id,
    text: `message ${id}`,
  }));
  await saveChatCheckpoint(dir, {
    version: 1,
    tabs: [{ id: "one", messages }],
  });
  expect(await loadChatMessages(dir, "one", 195, 12)).toEqual(
    messages.slice(195, 207),
  );
  await saveChatCheckpoint(dir, {
    version: 1,
    tabs: [
      {
        id: "one",
        messages: [{ id: 1000 }],
        checkpointPatch: { start: 1000, total: 1001 },
      },
    ],
  });
  expect(await loadChatMessages(dir, "one", 999, 2)).toEqual([
    messages[999],
    { id: 1000 },
  ]);
  await saveChatCheckpoint(dir, {
    version: 1,
    tabs: [
      {
        id: "one",
        messages: [],
        history: { start: 1001, total: 1001 },
        draft: "typed",
      },
    ],
  });
  expect(await loadChatMessages(dir, "one", 0, 1000)).toEqual(messages);
});

it("appends a review without reading old chunks and retains it for shared-session reads", async () => {
  const dir = await directory();
  await saveChatCheckpoint(dir, {
    version: 1,
    tabs: [
      {
        id: "one",
        runtimeSessionKey: "runtime",
        sharedSessionId: "shared",
        messages: Array.from({ length: 10001 }, (_, index) => ({ index })),
      },
    ],
  });
  const decision = {
    uuid: "review-one",
    type: "system",
    subtype: "draft_review_decisions",
  };
  const reads = vi.spyOn(fs, "readFile");
  try {
    expect(
      await appendChatReviewDecision(dir, "one", "runtime", decision),
    ).toBe(10002);
    expect(reads.mock.calls).toHaveLength(3); // manifest, tab metadata, final chunk
    expect(
      await appendChatReviewDecision(dir, "one", "runtime", decision),
    ).toBe(10002);
  } finally {
    reads.mockRestore();
  }
  expect(await loadChatMessages(dir, "one", 10000, 2)).toEqual([
    { index: 10000 },
    decision,
  ]);
  const snapshot = (await loadChatCheckpoint(dir))!;
  await saveChatCheckpoint(dir, snapshot);
  expect(await includeChatReviewDecisions(dir, "shared", [])).toEqual([
    decision,
  ]);
  expect(await includeChatReviewDecisions(dir, "shared", [decision])).toEqual([
    decision,
  ]);
  await saveChatCheckpoint(dir, { version: 1, tabs: [] });
  expect(await includeChatReviewDecisions(dir, "shared", [])).toEqual([
    decision,
  ]);
});
it("retries a failed append publication exactly once", async () => {
  const dir = await directory();
  await saveChatCheckpoint(dir, {
    version: 1,
    tabs: [{ id: "one", runtimeSessionKey: "runtime", messages: [] }],
  });
  const original = fs.rename;
  const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to).endsWith("manifest.json"))
      throw new Error("Disk unavailable");
    return original(from, to);
  });
  const decision = { uuid: "review-one", subtype: "draft_review_decisions" };
  try {
    await expect(
      appendChatReviewDecision(dir, "one", "runtime", decision),
    ).rejects.toThrow("Disk unavailable");
  } finally {
    rename.mockRestore();
  }
  expect((await loadChatCheckpoint(dir))!.tabs[0].history?.total).toBe(0);
  expect(await appendChatReviewDecision(dir, "one", "runtime", decision)).toBe(
    1,
  );
  expect(await appendChatReviewDecision(dir, "one", "runtime", decision)).toBe(
    1,
  );
  await expect(
    appendChatReviewDecision(dir, "one", "replaced", decision),
  ).rejects.toThrow("conversation changed");
});

it("forks a long chat using backend copies and trims only the final chunk", async () => {
  const dir = await directory();
  const messages = Array.from({ length: 10000 }, (_, index) => ({
    type: "assistant",
    uuid: `m-${index}`,
    message: { content: [{ type: "text", text: `Answer ${index}` }] },
  }));
  await saveChatCheckpoint(dir, {
    version: 1,
    tabs: [{ id: "source", runtimeSessionKey: "run", messages }],
  });
  const reads = vi.spyOn(fs, "readFile");
  let fork;
  try {
    fork = await forkSavedChat(dir, "source", "run", 8754, {
      id: "fork",
      runtimeSessionKey: "fork-run",
      provider: "codex",
      title: "Fork",
    });
    // One bounded read per written shared-session chunk, no full transcript read.
    expect(reads.mock.calls.length).toBeLessThan(100);
  } finally {
    reads.mockRestore();
  }
  expect(fork.history).toEqual({ start: 8755, total: 8755 });
  expect(fork.messages).toEqual([]);
  expect(await loadChatMessages(dir, "fork", 8750, 20)).toEqual(
    messages.slice(8750, 8755),
  );
  expect(await loadChatMessages(dir, "source", 9999, 1)).toEqual([
    messages[9999],
  ]);
  const shared = JSON.parse(
    await fs.readFile(
      path.join(dir, "..", `${fork.sharedSessionId}.json`),
      "utf8",
    ),
  );
  expect(shared.messages).toEqual(messages.slice(0, 8755));
  await cancelSavedFork(dir, "fork", String(fork.sharedSessionId));
  expect((await loadChatCheckpoint(dir))!.tabs.map((tab) => tab.id)).toEqual([
    "source",
  ]);
  expect(await loadChatMessages(dir, "source", 0, 1)).toEqual([messages[0]]);
});
it("prepares all unseen resume context while keeping renderer messages windowed", async () => {
  const dir = await directory();
  const messages = Array.from({ length: 1200 }, (_, index) => ({
    type: index % 2 ? "assistant" : "user",
    provider: "codex",
    message: {
      content: [{ type: "text", text: `Message ${index} ${"x".repeat(50)}` }],
    },
  }));
  await saveChatCheckpoint(dir, {
    version: 1,
    tabs: [
      {
        id: "one",
        runtimeSessionKey: "run",
        sharedSessionId: "shared",
        provider: "codex",
        messages,
      },
    ],
  });
  for (const retry of [false, true]) {
    for (const cursor of [0, 500, 1200]) {
      const prepared = await prepareSavedChatTurn(
        dir,
        "one",
        "run",
        cursor,
        retry,
      );
      expect(prepared.messages).toEqual(messages.slice(1000));
      expect(prepared.prefixCount).toBe(
        handoffMessageCount(messages.slice(0, 1000)),
      );
      expect(prepared.transcript).toBe(
        buildCrossProviderTranscript(
          retry ? messages.slice(0, -1) : messages,
          cursor,
        ),
      );
      if (cursor < 1200) {
        expect(prepared.transcript.length).toBeGreaterThan(12_000);
        expect(prepared.transcript).toContain(`Message ${cursor} `);
        expect(prepared.transcript).toContain(
          `Message ${retry ? 1198 : 1199} `,
        );
        expect(prepared.transcript).not.toContain(
          "[Earlier conversation truncated]",
        );
        if (cursor > 0)
          expect(prepared.transcript).not.toContain(`Message ${cursor - 1} `);
      } else expect(prepared.transcript).toBe("");
    }
  }
  await syncSavedChat(dir, "one", "run", {
    created_at: 123,
    archived: true,
    last_modified: 456,
  });
  const shared = JSON.parse(
    await fs.readFile(path.join(dir, "..", "shared.json"), "utf8"),
  );
  expect(shared.messages).toEqual(messages);
  expect(shared.created_at).toBe(123);
  expect(shared.archived).toBe(true);
  await fs.rm(path.join(dir, "..", "shared.json"));
});

it("does not publish a fork when copying fails", async () => {
  const dir = await directory();
  await saveChatCheckpoint(dir, {
    version: 1,
    tabs: [
      {
        id: "source",
        runtimeSessionKey: "run",
        messages: Array.from({ length: 400 }, () => ({ type: "assistant" })),
      },
    ],
  });
  const before = await fs.readdir(dir);
  const original = fs.copyFile;
  let copies = 0;
  const copy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
    if (++copies === 2) throw new Error("Disk full");
    return original(...args);
  });
  try {
    await expect(
      forkSavedChat(dir, "source", "run", 350, {
        id: "fork",
        runtimeSessionKey: "new",
      }),
    ).rejects.toThrow("Disk full");
  } finally {
    copy.mockRestore();
  }
  expect(await fs.readdir(dir)).toEqual(before);
  expect((await loadChatCheckpoint(dir))!.tabs.map((tab) => tab.id)).toEqual([
    "source",
  ]);
  expect(await loadChatMessages(dir, "source", 399, 1)).toEqual([
    { type: "assistant" },
  ]);
});
