import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";

export interface CommentSourceCheck {
  requestId: string;
  projectRoot: string;
  filePath: string;
  tabId: string;
  sessionId: string;
  sha1: string;
}

// Check unsaved source buffers as well as the backend's on-disk comparison.
export async function commentSourceMatches(
  request: CommentSourceCheck,
): Promise<boolean> {
  const state = useDocumentStore.getState();
  const tab = useAgentChatStore
    .getState()
    .tabs.find((tab) => tab.id === request.tabId);
  if (
    state.projectRoot !== request.projectRoot ||
    !tab?.isStreaming ||
    tab.runtimeSessionKey !== request.sessionId
  )
    return false;
  const files = state.sourceViewSnapshot?.files ?? state.files;
  const file = files.find((file) => file.relativePath === request.filePath);
  if (!file || typeof file.content !== "string") return !file?.isDirty;
  const content = file.content;
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(content),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const current = useDocumentStore.getState();
  const currentTab = useAgentChatStore
    .getState()
    .tabs.find((tab) => tab.id === request.tabId);
  const currentFile = (current.sourceViewSnapshot?.files ?? current.files).find(
    (file) => file.relativePath === request.filePath,
  );
  return (
    current.projectRoot === request.projectRoot &&
    currentTab?.isStreaming === true &&
    currentTab.runtimeSessionKey === request.sessionId &&
    currentFile?.content === content &&
    hash === request.sha1
  );
}
