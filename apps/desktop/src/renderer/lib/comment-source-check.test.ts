import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { commentSourceMatches } from "./comment-source-check";

const mocks = vi.hoisted(() => ({
  document: {
    projectRoot: "/project",
    files: [{ relativePath: "main.tex", content: "same", isDirty: false }],
    sourceViewSnapshot: null as null | {
      files: { relativePath: string; content: string; isDirty: boolean }[];
    },
  },
  chat: {
    tabs: [{ id: "tab", runtimeSessionKey: "session", isStreaming: true }],
  },
}));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: { getState: () => mocks.document },
}));
vi.mock("@/stores/agent-chat-store", () => ({
  useAgentChatStore: { getState: () => mocks.chat },
}));
const request = {
  requestId: "request",
  projectRoot: "/project",
  filePath: "main.tex",
  tabId: "tab",
  sessionId: "session",
  sha1: "ff3390557335ba88d37755e41514beb03bc499ec",
};
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  mocks.document.projectRoot = "/project";
  mocks.document.files = [
    { relativePath: "main.tex", content: "same", isDirty: false },
  ];
  mocks.document.sourceViewSnapshot = null;
  mocks.chat.tabs = [
    { id: "tab", runtimeSessionKey: "session", isStreaming: true },
  ];
});
it("accepts unchanged source and rejects wrong project or stale session", async () => {
  expect(await commentSourceMatches(request)).toBe(true);
  expect(
    await commentSourceMatches({ ...request, projectRoot: "/other" }),
  ).toBe(false);
  expect(await commentSourceMatches({ ...request, sessionId: "old" })).toBe(
    false,
  );
  mocks.chat.tabs[0].isStreaming = false;
  expect(await commentSourceMatches(request)).toBe(false);
});
it("checks unsaved source buffers even while the editor shows a draft", async () => {
  mocks.document.files[0].content = "draft";
  mocks.document.sourceViewSnapshot = {
    files: [{ relativePath: "main.tex", content: "same", isDirty: true }],
  };
  expect(await commentSourceMatches(request)).toBe(true);
  mocks.document.sourceViewSnapshot.files[0].content = "unsaved change";
  expect(await commentSourceMatches(request)).toBe(false);
});
it("rechecks session and buffer after hashing", async () => {
  mocks.document.files[0].isDirty = true;
  const pending = commentSourceMatches(request);
  mocks.chat.tabs[0].isStreaming = false;
  expect(await pending).toBe(false);
  mocks.chat.tabs[0].isStreaming = true;
  const edited = commentSourceMatches(request);
  mocks.document.files[0].content = "edited during hash";
  expect(await edited).toBe(false);
});
