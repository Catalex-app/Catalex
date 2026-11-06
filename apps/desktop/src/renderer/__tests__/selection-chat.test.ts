import { afterEach, beforeEach, expect, it } from "vitest";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import {
  pinFileToChat,
  pinSelectionToChat,
  selectionChatTargets,
} from "@/lib/selection-chat";
import type { PanelWindowSession } from "@/lib/panel-window-runtime";

const initialChat = useAgentChatStore.getState();
const initialDocument = useDocumentStore.getState();
const context = {
  label: "@main.tex:1:1-1:5",
  filePath: "main.tex",
  selectedText: "text",
};

beforeEach(() => {
  useDocumentStore.setState({ projectRoot: "/project" });
  useAgentChatStore.setState({
    chatProjectRoot: "/project",
    activeTabId: "main",
    tabs: ["main", "popout", "closed", "archived"].map((id) => ({
      ...initialChat.tabs[0],
      id,
      archived: id === "archived",
      draft: { input: `Draft ${id}`, pinnedContexts: [] },
    })),
  });
  window.__catalexPanelSessions = new Map([
    [
      "popout",
      {
        kind: "chat",
        chatId: "popout",
        window: { closed: false },
      } as PanelWindowSession,
    ],
  ]);
});
afterEach(() => {
  useAgentChatStore.setState(initialChat, true);
  useDocumentStore.setState(initialDocument, true);
  delete window.__catalexPanelSessions;
});

it("lists only eligible chats and gives the main chat one entry even with a pop-out", () => {
  expect(
    selectionChatTargets(
      [...useAgentChatStore.getState().tabs].reverse(),
      "main",
      "main\npopout\narchived",
    ).map(({ tab, location }) => [tab.id, location]),
  ).toEqual([
    ["main", "Main & Pop-out"],
    ["popout", "Pop-out"],
  ]);
});

it("pins an excerpt once while preserving the draft, attachments, other tabs, and active chat", () => {
  const store = useAgentChatStore.getState();
  const attachment = {
    label: "file",
    filePath: "image.png",
    selectedText: "",
    attachment: true,
  };
  store.saveDraft("popout", {
    input: "Keep typing",
    pinnedContexts: [attachment, context],
  });
  expect(pinSelectionToChat("popout", context, "/project")).toBe(true);
  expect(pinSelectionToChat("popout", context, "/project")).toBe(true);
  const after = useAgentChatStore.getState();
  expect(after.activeTabId).toBe("main");
  expect(after.tabs.find((tab) => tab.id === "popout")?.draft).toEqual({
    input: "Keep typing",
    pinnedContexts: [attachment, { ...context, selectionPinned: true }],
  });
  expect(after.tabs[0].draft).toEqual({
    input: "Draft main",
    pinnedContexts: [],
  });
});

it("rejects a closed, archived, or stale-project target without modifying drafts", () => {
  const before = useAgentChatStore.getState().tabs;
  expect(pinSelectionToChat("closed", context, "/project")).toBe(false);
  expect(pinSelectionToChat("archived", context, "/project")).toBe(false);
  window.__catalexPanelSessions!.get("popout")!.window = {
    closed: true,
  } as Window;
  expect(pinSelectionToChat("popout", context, "/project")).toBe(false);
  expect(pinSelectionToChat("main", context, "/previous-project")).toBe(false);
  useDocumentStore.setState({ projectRoot: "/different-project" });
  expect(pinSelectionToChat("main", context, "/different-project")).toBe(false);
  expect(useAgentChatStore.getState().tabs).toBe(before);
});

it("keeps same-named PDF documents separate and updates only the repeated excerpt", () => {
  const pdf = (documentPath: string) => ({
    label: "PDF p.1 · “Introduction”",
    filePath: documentPath,
    selectedText: "Introduction",
    pdf: { documentPath, kind: "compiled" as const, page: 1 },
    selectionKey: `pdf:${JSON.stringify(["compiled", documentPath, 1, 120, 150, "Introduction"])}`,
  });
  const a = pdf("papers/a/main.tex");
  const b = pdf("papers/b/main.tex");
  pinSelectionToChat("main", a, "/project");
  pinSelectionToChat("main", b, "/project");
  const mappedA = {
    ...a,
    label: "PDF p.1 · @shared/intro.tex:1:1-1:13",
    filePath: "shared/intro.tex",
    selectedText: "Introduction\n\n[Source: shared/intro.tex, line 1]",
  };
  pinSelectionToChat("main", mappedA, "/project");
  expect(useAgentChatStore.getState().tabs[0].draft.pinnedContexts).toEqual([
    { ...b, selectionPinned: true },
    { ...mappedA, selectionPinned: true },
  ]);
});

it("pins whole-file references to the chosen chat, including empty PDFs, and refreshes only that file", () => {
  expect(pinFileToChat("popout", "paper.pdf", "", "/project")).toBe(true);
  expect(pinFileToChat("popout", "notes.tex", "First draft", "/project")).toBe(
    true,
  );
  expect(
    pinFileToChat("popout", "notes.tex", "Unsaved revision", "/project"),
  ).toBe(true);
  const state = useAgentChatStore.getState();
  expect(state.activeTabId).toBe("main");
  expect(state.tabs[0].draft.pinnedContexts).toEqual([]);
  expect(state.tabs[1].draft).toEqual({
    input: "Draft popout",
    pinnedContexts: [
      {
        label: "@paper.pdf",
        filePath: "paper.pdf",
        selectedText: "",
        selectionKey: "file:paper.pdf",
        selectionPinned: true,
      },
      {
        label: "@notes.tex",
        filePath: "notes.tex",
        selectedText: "Unsaved revision",
        selectionKey: "file:notes.tex",
        selectionPinned: true,
      },
    ],
  });
  expect(
    pinSelectionToChat("main", { ...context, selectedText: "" }, "/project"),
  ).toBe(false);
});

it("refuses whole-file sends to stale projects or chats that are no longer available", () => {
  const before = useAgentChatStore.getState().tabs;
  expect(pinFileToChat("closed", "paper.pdf", "", "/project")).toBe(false);
  expect(pinFileToChat("archived", "paper.pdf", "", "/project")).toBe(false);
  expect(pinFileToChat("main", "paper.pdf", "", "/previous-project")).toBe(
    false,
  );
  window.__catalexPanelSessions!.get("popout")!.window = {
    closed: true,
  } as Window;
  expect(pinFileToChat("popout", "paper.pdf", "", "/project")).toBe(false);
  expect(useAgentChatStore.getState().tabs).toBe(before);
});
