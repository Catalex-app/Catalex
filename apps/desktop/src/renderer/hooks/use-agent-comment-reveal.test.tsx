import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentCommentReveal } from "./use-agent-comment-reveal";
import { useSettingsStore } from "@/stores/settings-store";
import type { CommentChangeEvent } from "@/components/workspace/editor/inline-comment-storage";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@/lib/desktop/event", () => ({
  listen: vi.fn(async (event, handler) => {
    mocks.handlers.set(event, handler);
    return () => mocks.handlers.delete(event);
  }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
const key = JSON.stringify("/project");
const saved: CommentChangeEvent = {
  projectRoot: "/project",
  tabId: "review",
  patch: {
    filePath: "main.tex",
    id: "a1",
    before: null,
    after: {
      id: "a1",
      from: 0,
      to: 4,
      line: 1,
      text: "Clarify this",
      origin: { provider: "codex", sessionId: "session" },
    },
  },
};
function emit(event: string, payload: unknown) {
  mocks.handlers.get(event)?.({ payload });
}
function Harness() {
  useAgentCommentReveal();
  return null;
}
beforeEach(async () => {
  mocks.handlers.clear();
  useSettingsStore.setState({
    editorCommentsPanelOpenByProject: {},
    editorCommentFilterByProject: { [key]: "human" },
  });
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(mocks.handlers.size).toBe(0);
});

it.each([
  "claude-complete",
  "codex-complete",
  "pi-complete",
])("reveals saved comments only after their turn ends (%s)", (event) => {
  emit("catalex-comments-changed", saved);
  expect(
    useSettingsStore.getState().editorCommentsPanelOpenByProject[key],
  ).toBeUndefined();
  emit(event, { tab_id: "other", success: true });
  expect(useSettingsStore.getState().editorCommentFilterByProject[key]).toBe(
    "human",
  );
  emit(event, { tab_id: "review", success: true });
  expect(
    useSettingsStore.getState().editorCommentsPanelOpenByProject[key],
  ).toBe(true);
  expect(useSettingsStore.getState().editorCommentFilterByProject[key]).toBe(
    "agent",
  );
  useSettingsStore.getState().setEditorCommentsPanelOpen(key, false);
  useSettingsStore.getState().setEditorCommentFilter(key, "all");
  emit(event, { tab_id: "review", success: true });
  expect(
    useSettingsStore.getState().editorCommentsPanelOpenByProject[key],
  ).toBe(false);
  expect(useSettingsStore.getState().editorCommentFilterByProject[key]).toBe(
    "all",
  );
});

it("ignores human additions, edits, and turns without saved comments", () => {
  emit("catalex-comments-changed", {
    ...saved,
    patch: {
      ...saved.patch,
      after: { ...saved.patch.after, origin: undefined },
    },
  });
  emit("catalex-comments-changed", {
    ...saved,
    patch: { ...saved.patch, before: saved.patch.after },
  });
  emit("catalex-comments-changed", { ...saved, tabId: undefined });
  emit("codex-complete", { tab_id: "review", success: true });
  expect(useSettingsStore.getState().editorCommentsPanelOpenByProject).toEqual(
    {},
  );
});

it("routes simultaneous reviews to their own projects, including saved comments from a failed turn", () => {
  emit("catalex-comments-changed", saved);
  emit("catalex-comments-changed", {
    ...saved,
    tabId: "second",
    projectRoot: "/second",
  });
  emit("claude-complete", { tab_id: "second", success: false });
  expect(useSettingsStore.getState().editorCommentsPanelOpenByProject).toEqual({
    [JSON.stringify("/second")]: true,
  });
  emit("codex-complete", { tab_id: "review", success: true });
  expect(
    useSettingsStore.getState().editorCommentsPanelOpenByProject[key],
  ).toBe(true);
});
