import { buildTranscriptEntries } from "../chat-transcript";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const PAGE_SIZE = 100;
interface Tab {
  id: string;
  messages?: unknown[];
  history?: { total: number; start: number };
  checkpointPatch?: { start: number; total: number };
  [key: string]: unknown;
}
interface Checkpoint {
  version: 1;
  tabs: Tab[];
  [key: string]: unknown;
}
interface StoredTab {
  tab: Tab;
  chunks: string[];
  total: number;
  appends?: Array<{ id: string; index: number }>;
}
interface Manifest {
  reviewDecisions?: Record<string, string[]>;
  version: 1;
  tabs: Array<{ id: string; file: string }>;
  state: Omit<Checkpoint, "tabs">;
}
const safeFile = (file: string) => /^[a-f0-9-]+\.json$/.test(file);
async function readJson(directory: string, file: string) {
  if (!safeFile(file) && file !== "manifest.json")
    throw new Error("Invalid checkpoint file.");
  return JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
}
async function writeObject(directory: string, value: unknown) {
  const serialized = JSON.stringify(value);
  const file = `${createHash("sha256").update(serialized).digest("hex")}.json`;
  try {
    await fs.access(path.join(directory, file));
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx");
  try {
    await handle.writeFile(serialized);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, path.join(directory, file));
  return file;
}

/** Immutable chunks + manifest-last publication preserve the last successful save. */
export async function saveChatCheckpoint(
  directory: string,
  snapshot: Checkpoint,
) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.tabs))
    throw new Error("Invalid chat checkpoint.");
  await fs.mkdir(directory, { recursive: true });
  const previous = await readManifest(directory);
  const tabs: Manifest["tabs"] = [];
  const retained = new Set([
    "manifest.json",
    ...Object.values(previous?.reviewDecisions ?? {}).flat(),
  ]);
  for (const input of snapshot.tabs) {
    if (typeof input.id !== "string") throw new Error("Invalid chat ID.");
    const { messages = [], history, checkpointPatch, ...metadata } = input;
    let chunks: string[];
    let total: number;
    if (history || checkpointPatch) {
      const existing = previous?.tabs.find((item) => item.id === input.id);
      if (!existing) throw new Error("The unloaded chat has no saved history.");
      const stored = (await readJson(directory, existing.file)) as StoredTab;
      chunks = stored.chunks;
      total = stored.total;
      if (checkpointPatch) {
        const { start, total: nextTotal } = checkpointPatch;
        if (
          start % PAGE_SIZE !== 0 ||
          start < 0 ||
          start > total ||
          nextTotal !== start + messages.length
        )
          throw new Error("Invalid incremental checkpoint.");
        chunks = chunks.slice(0, start / PAGE_SIZE);
        for (let offset = 0; offset < messages.length; offset += PAGE_SIZE)
          chunks.push(
            await writeObject(
              directory,
              messages.slice(offset, offset + PAGE_SIZE),
            ),
          );
        total = nextTotal;
      }
    } else {
      chunks = [];
      total = messages.length;
      for (let offset = 0; offset < messages.length; offset += PAGE_SIZE)
        chunks.push(
          await writeObject(
            directory,
            messages.slice(offset, offset + PAGE_SIZE),
          ),
        );
    }
    const oldEntry = previous?.tabs.find((item) => item.id === input.id);
    const old = oldEntry
      ? ((await readJson(directory, oldEntry.file)) as StoredTab)
      : undefined;
    const appends = old?.appends;
    const file = await writeObject(directory, {
      tab: metadata,
      chunks,
      total,
      appends,
    });
    tabs.push({ id: input.id, file });
    retained.add(file);
    for (const chunk of chunks) retained.add(chunk);
  }
  const { tabs: _tabs, ...state } = snapshot;
  const file = await writeObject(directory, {
    version: 1,
    state,
    tabs,
    reviewDecisions: previous?.reviewDecisions,
  });
  await fs.rename(
    path.join(directory, file),
    path.join(directory, "manifest.json"),
  );
  // Readers/writers are serialized by the host, so published references stay valid.
  for (const file of await fs.readdir(directory)) {
    if (!retained.has(file) && /^[a-f0-9-]+\.(json|tmp)$/.test(file))
      await fs.unlink(path.join(directory, file)).catch(() => {});
  }
}

async function readManifest(directory: string): Promise<Manifest | null> {
  let manifest: Manifest;
  try {
    manifest = await readJson(directory, "manifest.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.tabs) ||
    manifest.tabs.some((tab) => !safeFile(tab.file))
  )
    throw new Error("The chat checkpoint is invalid.");
  return manifest;
}

export async function loadChatCheckpoint(
  directory: string,
): Promise<Checkpoint | null> {
  const manifest = await readManifest(directory);
  if (!manifest) return null;
  const tabs: Tab[] = [];
  for (const entry of manifest.tabs) {
    const stored = (await readJson(directory, entry.file)) as StoredTab;
    if (stored.tab.id !== entry.id)
      throw new Error("The chat checkpoint is invalid.");
    // Older checkpoints kept answered questions in metadata and relied on the
    // loaded transcript to hide them. Repair before returning unloaded tabs,
    // reading one chunk at a time only for chats with a pending question.
    const question = stored.tab.pendingQuestion as
      | { requestId?: string }
      | null
      | undefined;
    if (typeof question?.requestId === "string") {
      const answerId = `question-answer-${question.requestId}`;
      for (const file of stored.chunks) {
        const messages = (await readJson(directory, file)) as Array<{
          uuid?: string;
        }>;
        if (messages.some((message) => message?.uuid === answerId)) {
          stored.tab.pendingQuestion = null;
          break;
        }
      }
    }
    tabs.push({
      ...stored.tab,
      messages: [],
      history: { total: stored.total, start: stored.total },
    });
  }
  return { ...manifest.state, version: 1, tabs };
}

export async function loadChatMessages(
  directory: string,
  tabId: string,
  start: number,
  limit: number,
) {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 0
  )
    throw new Error("Invalid message range.");
  const manifest = await readManifest(directory);
  const entry = manifest?.tabs.find((tab) => tab.id === tabId);
  if (!entry) throw new Error("The saved chat could not be found.");
  const stored = (await readJson(directory, entry.file)) as StoredTab;
  const end = Math.min(stored.total, start + limit);
  const messages: unknown[] = [];
  for (
    let i = Math.floor(start / PAGE_SIZE);
    i < Math.ceil(end / PAGE_SIZE);
    i++
  ) {
    const chunk = (await readJson(directory, stored.chunks[i])) as unknown[];
    messages.push(
      ...chunk.slice(
        Math.max(0, start - i * PAGE_SIZE),
        Math.min(PAGE_SIZE, end - i * PAGE_SIZE),
      ),
    );
  }
  return messages;
}

/** Host serialization makes the transcript append and compatibility record one commit. */
export async function appendChatReviewDecision(
  directory: string,
  tabId: string,
  runtimeSessionKey: string,
  message: { uuid: string; subtype: string; [key: string]: unknown },
) {
  if (!message.uuid || message.subtype !== "draft_review_decisions")
    throw new Error("Invalid review decision.");
  const manifest = await readManifest(directory);
  const entry = manifest?.tabs.find((tab) => tab.id === tabId);
  if (!manifest || !entry)
    throw new Error("The saved chat could not be found.");
  const stored = (await readJson(directory, entry.file)) as StoredTab;
  if (stored.tab.runtimeSessionKey !== runtimeSessionKey)
    throw new Error("The conversation changed before the decision was saved.");
  const appended = stored.appends?.find((item) => item.id === message.uuid);
  if (appended && appended.index < stored.total) {
    const chunk = await readJson(
      directory,
      stored.chunks[Math.floor(appended.index / PAGE_SIZE)],
    );
    if (chunk[appended.index % PAGE_SIZE]?.uuid === message.uuid)
      return stored.total;
  }
  const chunks = [...stored.chunks];
  const last =
    stored.total % PAGE_SIZE
      ? ((await readJson(directory, chunks.pop()!)) as unknown[])
      : [];
  chunks.push(await writeObject(directory, [...last, message]));
  const file = await writeObject(directory, {
    ...stored,
    chunks,
    total: stored.total + 1,
    appends: [
      ...(stored.appends ?? []).filter((item) => item.id !== message.uuid),
      { id: message.uuid, index: stored.total },
    ],
  });
  const reviewDecisions = { ...manifest.reviewDecisions };
  if (typeof stored.tab.sharedSessionId === "string") {
    const key = createHash("sha256")
      .update(stored.tab.sharedSessionId)
      .digest("hex");
    reviewDecisions[key] = [
      ...new Set([
        ...(reviewDecisions[key] ?? []),
        await writeObject(directory, message),
      ]),
    ];
  }
  const published = await writeObject(directory, {
    ...manifest,
    reviewDecisions,
    tabs: manifest.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, file } : tab,
    ),
  });
  await fs.rename(
    path.join(directory, published),
    path.join(directory, "manifest.json"),
  );
  return stored.total + 1;
}

export async function includeChatReviewDecisions(
  directory: string,
  sharedSessionId: string,
  messages: Array<{ uuid?: string }>,
) {
  const manifest = await readManifest(directory);
  const key = createHash("sha256").update(sharedSessionId).digest("hex");
  const ids = new Set(messages.map((message) => message.uuid));
  const result = [...messages];
  for (const file of manifest?.reviewDecisions?.[key] ?? []) {
    const message = await readJson(directory, file);
    if (!ids.has(message.uuid)) {
      ids.add(message.uuid);
      result.push(message);
    }
  }
  return result;
}

async function storedChat(
  directory: string,
  tabId: string,
  runtimeSessionKey: string,
) {
  const manifest = await readManifest(directory);
  const entry = manifest?.tabs.find((tab) => tab.id === tabId);
  if (!manifest || !entry)
    throw new Error("The saved chat could not be found.");
  const stored = (await readJson(directory, entry.file)) as StoredTab;
  if (stored.tab.runtimeSessionKey !== runtimeSessionKey)
    throw new Error("The conversation changed.");
  return { manifest, stored };
}

// Shared-session JSON stays compatible with the native service. Only one chunk
// is decoded at a time; publication replaces the file after all writes succeed.
async function writeSharedChat(
  directory: string,
  stored: StoredTab,
  state: Manifest["state"],
  previous?: {
    created_at: number;
    archived: boolean;
    last_modified: number;
  } | null,
) {
  const tab = stored.tab;
  const id = tab.sharedSessionId;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("Invalid shared session ID.");
  const now = Math.floor(Date.now() / 1000);
  const metadata = {
    id,
    title: tab.title || "New Chat",
    created_at: previous?.created_at ?? now,
    updated_at: Math.max(
      previous?.last_modified ?? 0,
      Number(tab.lastActivityAt ?? now),
    ),
    archived: previous?.archived ?? Boolean(tab.archived),
    last_provider: tab.provider,
    last_claude_model: state.selectedClaudeModel ?? null,
    last_codex_model: state.selectedCodexModel ?? null,
    last_pi_model: state.selectedPiModel ?? null,
    provider_session_ids: tab.providerSessionIds ?? {},
    provider_sync_cursors: tab.providerSyncCursors ?? {},
    pending_question: tab.pendingQuestion ?? null,
  };
  const target = path.join(directory, "..", `${id}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(
        `${JSON.stringify(metadata).slice(0, -1)},"messages":[`,
      );
      let first = true;
      for (const file of stored.chunks) {
        const chunk = (await readJson(directory, file)) as unknown[];
        if (!chunk.length) continue;
        await handle.writeFile(
          `${first ? "" : ","}${JSON.stringify(chunk).slice(1, -1)}`,
        );
        first = false;
      }
      await handle.writeFile("]}");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { shared_session_id: id, last_modified: metadata.updated_at };
}

export async function syncSavedChat(
  directory: string,
  tabId: string,
  runtimeSessionKey: string,
  previous?: {
    created_at: number;
    archived: boolean;
    last_modified: number;
  } | null,
  pendingQuestion?: unknown,
) {
  const { manifest, stored } = await storedChat(
    directory,
    tabId,
    runtimeSessionKey,
  );
  if (pendingQuestion !== undefined)
    stored.tab.pendingQuestion = pendingQuestion;
  return writeSharedChat(directory, stored, manifest.state, previous);
}

export async function forkSavedChat(
  directory: string,
  sourceId: string,
  runtimeSessionKey: string,
  messageIndex: number,
  tab: Tab,
): Promise<Tab> {
  const { manifest, stored } = await storedChat(
    directory,
    sourceId,
    runtimeSessionKey,
  );
  if (
    !Number.isSafeInteger(messageIndex) ||
    messageIndex < 0 ||
    messageIndex >= stored.total ||
    manifest.tabs.some((item) => item.id === tab.id)
  )
    throw new Error("Invalid fork point.");
  const finalIndex = Math.floor(messageIndex / PAGE_SIZE);
  const finalChunk = (await readJson(
    directory,
    stored.chunks[finalIndex],
  )) as Array<{ type?: string }>;
  if (
    !["assistant", "result"].includes(
      finalChunk[messageIndex % PAGE_SIZE]?.type ?? "",
    )
  )
    throw new Error("Forks must end at an assistant response.");
  const sharedSessionId = randomUUID();
  const copied: string[] = [];
  const { messages: _messages, history: _history, ...metadata } = tab;
  const fork: StoredTab = {
    tab: {
      ...metadata,
      sharedSessionId,
      sessionId: null,
      providerSessionIds: {},
      providerSyncCursors: {},
    },
    chunks: [],
    total: messageIndex + 1,
  };
  try {
    for (let index = 0; index < finalIndex; index++) {
      const file = `${randomUUID()}.json`;
      copied.push(file);
      await fs.copyFile(
        path.join(directory, stored.chunks[index]),
        path.join(directory, file),
      );
      fork.chunks.push(file);
    }
    fork.chunks.push(
      await writeObject(
        directory,
        finalChunk.slice(0, (messageIndex % PAGE_SIZE) + 1),
      ),
    );
    const file = await writeObject(directory, fork);
    await writeSharedChat(directory, fork, manifest.state);
    const published = await writeObject(directory, {
      ...manifest,
      tabs: [...manifest.tabs, { id: tab.id, file }],
    });
    await fs.rename(
      path.join(directory, published),
      path.join(directory, "manifest.json"),
    );
    return {
      ...fork.tab,
      messages: [],
      history: { start: fork.total, total: fork.total },
    };
  } catch (error) {
    await Promise.all(
      [
        ...copied.map((file) => path.join(directory, file)),
        path.join(directory, "..", `${sharedSessionId}.json`),
      ].map((file) => fs.rm(file, { force: true })),
    );
    throw error;
  }
}

export async function prepareSavedChatTurn(
  directory: string,
  tabId: string,
  runtimeSessionKey: string,
  cursor: number,
  retry: boolean,
) {
  const { stored } = await storedChat(directory, tabId, runtimeSessionKey);
  const start = Math.max(
    0,
    Math.floor((stored.total - 200) / PAGE_SIZE) * PAGE_SIZE,
  );
  let count = 0,
    prefixCount = 0;
  const transcript: string[] = [];
  let latestReview: unknown = null;
  const messages: unknown[] = [];
  for (let index = 0; index < stored.chunks.length; index++) {
    const chunk = await readJson(directory, stored.chunks[index]);
    for (let offset = 0; offset < chunk.length; offset++) {
      const message = chunk[offset];
      const position = index * PAGE_SIZE + offset;
      if (position >= start) messages.push(message);
      if (message.subtype === "draft_review_decisions") latestReview = message;
      const entries = buildTranscriptEntries([message]);
      if (position < start) prefixCount += entries.length;
      for (const entry of entries) {
        if (count >= cursor && !(retry && position === stored.total - 1)) {
          transcript.push(entry);
        }
        count++;
      }
    }
  }
  return {
    start,
    total: stored.total,
    messages,
    prefixCount,
    latestReview,
    transcript: transcript.join("\n\n"),
  };
}

export async function cancelSavedFork(
  directory: string,
  tabId: string,
  sharedSessionId: string,
) {
  const snapshot = await loadChatCheckpoint(directory);
  const tab = snapshot?.tabs.find((tab) => tab.id === tabId);
  if (
    !snapshot ||
    !tab ||
    tab.sharedSessionId !== sharedSessionId ||
    !/^[a-zA-Z0-9_-]+$/.test(sharedSessionId)
  )
    throw new Error("The fork changed before cancellation.");
  await saveChatCheckpoint(directory, {
    ...snapshot,
    tabs: snapshot.tabs.filter((tab) => tab.id !== tabId),
  });
  await fs.rm(path.join(directory, "..", `${sharedSessionId}.json`), {
    force: true,
  });
}
