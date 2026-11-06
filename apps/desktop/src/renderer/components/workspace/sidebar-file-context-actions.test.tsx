import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import {
  SidebarFileContextActions,
  sendSidebarFileToChat,
} from "./sidebar-file-context-actions";

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenuItem: ({
    textValue: _textValue,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    textValue?: string;
  }) => <button {...props} />,
  ContextMenuSeparator: () => <hr />,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const file: ProjectFile = {
  id: "chapters/main.tex",
  name: "main.tex",
  relativePath: "chapters/main.tex",
  absolutePath: "/project/chapters/main.tex",
  type: "tex",
  content: "Unsaved working text",
  isDirty: true,
};
const initialChat = useAgentChatStore.getState();
const initialDocument = useDocumentStore.getState();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
  useAgentChatStore.setState({
    chatProjectRoot: "/project",
    activeTabId: "main",
    tabs: [
      {
        ...initialChat.tabs[0],
        id: "main",
        draft: { input: "Keep draft", pinnedContexts: [] },
      },
    ],
    pendingAttachments: [],
    drawerOpenRequested: false,
  });
  useDocumentStore.setState({
    projectRoot: "/project",
    activeFileId: "other.tex",
  });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useAgentChatStore.setState(initialChat, true);
  useDocumentStore.setState(initialDocument, true);
});

it("keeps one file attachment without opening the drawer and preserving unsaved content", () => {
  sendSidebarFileToChat(file, "main", "/project");
  sendSidebarFileToChat(file, "main", "/project");
  expect(useAgentChatStore.getState().drawerOpenRequested).toBe(false);
  expect(useAgentChatStore.getState().pendingAttachments).toEqual([]);
  expect(useAgentChatStore.getState().tabs[0].draft.input).toBe("Keep draft");
  expect(useAgentChatStore.getState().tabs[0].draft.pinnedContexts).toEqual([
    {
      label: `@${file.relativePath}`,
      filePath: file.relativePath,
      selectedText: file.content,
      selectionPinned: true,
      selectionKey: `file:${file.relativePath}`,
    },
  ]);
});

it("copies the absolute path and reveals the selected file through the existing native command", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  await act(async () =>
    root.render(<SidebarFileContextActions file={file} aiEnabled />),
  );
  const buttons = container.querySelectorAll("button");
  await act(async () => {
    Array.from(buttons)
      .find((button) => button.textContent?.includes("Copy file path"))!
      .click();
    Array.from(buttons)
      .find((button) => button.textContent?.includes("Open in"))!
      .click();
  });
  expect(writeText).toHaveBeenCalledWith(file.absolutePath);
  expect(invoke).toHaveBeenCalledWith("open_in_editor", {
    editorId: "finder",
    projectPath: "/project",
    filePath: file.relativePath,
  });
});

it("hides Send to chat in pure mode and disables reveal without a project", async () => {
  useDocumentStore.setState({ projectRoot: null });
  await act(async () =>
    root.render(<SidebarFileContextActions file={file} aiEnabled={false} />),
  );
  expect(container.textContent).not.toContain("Send to chat");
  expect(container.querySelectorAll("button")[1].disabled).toBe(true);
});
