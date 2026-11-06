import type { StoreApi, UseBoundStore } from "zustand";
import { resolveTexRoot, type DocumentState } from "@/stores/document-store";
import { getPanelWindowSession } from "./panel-window-runtime";

/** A file-pinned view over the owner's document store; only view state is local. */
export function connectPanelDocumentView(
  store: UseBoundStore<StoreApi<DocumentState>>,
) {
  const session = getPanelWindowSession();
  if (!session) return;
  const parent = session.document;
  const local = store.getState();
  const viewKeys = [
    "cursorPosition",
    "outlineScrollPosition",
    "selectionRange",
    "selectionPreviewRange",
    "jumpToPosition",
    "jumpToSelectionRange",
    "commentSelectionContext",
    "pdfSelectionContext",
  ] as const;
  const pinnedActions = {
    setActiveFile: () => {},
    closeOpenFile: () => {},
    setCursorPosition: local.setCursorPosition,
    setSelectionRange: local.setSelectionRange,
    setSelectionPreviewRange: local.setSelectionPreviewRange,
    setCommentSelectionContext: local.setCommentSelectionContext,
    setPdfSelectionContext: local.setPdfSelectionContext,
    requestJumpToPosition: local.requestJumpToPosition,
    requestJumpToSelectionRange: local.requestJumpToSelectionRange,
    clearJumpRequest: local.clearJumpRequest,
    insertAtCursor: local.insertAtCursor,
    replaceSelection: local.replaceSelection,
    findAndReplace: local.findAndReplace,
    setContent: (content: string, base?: string) => {
      if (!parent.getState().isApplyingAgentDraft)
        parent.getState().updateFileContent(session.fileId, content, base);
    },
    saveCurrentFile: () => parent.getState().saveFile(session.fileId),
    setFileName: (name: string) => {
      void parent.getState().renameFile(session.fileId, name);
    },
  };
  let applying = false;
  const publish = () => {
    const source = parent.getState();
    const current = store.getState();
    const view = Object.fromEntries(viewKeys.map((key) => [key, current[key]]));
    const liveFile = source.files.find((file) => file.id === session.fileId);
    // Deleted files are temporarily absent while the draft tree is installed.
    // Keep their source visible until the shared review adds its deletion entry.
    const file =
      liveFile ??
      source.sourceViewSnapshot?.files.find(
        (file) => file.id === session.fileId,
      );
    const changedWorkspace =
      source.agentWorkspaceRoot !== current.agentWorkspaceRoot;
    applying = true;
    try {
      store.setState(
        session.kind === "chat"
          ? source
          : {
              ...source,
              ...view,
              ...pinnedActions,
              ...(!liveFile && file
                ? {
                    files: [...source.files, file],
                    isAgentWorkspaceReadOnly: true,
                  }
                : {}),
              ...(changedWorkspace
                ? {
                    selectionRange: null,
                    selectionPreviewRange: null,
                    commentSelectionContext: null,
                    pdfSelectionContext: null,
                  }
                : {}),
              activeFileId: session.fileId,
              openFileIds: [session.fileId],
              compileError:
                source.compileErrorCache.get(
                  resolveTexRoot(session.fileId, source.files) ?? "",
                ) ?? null,
              content: file?.content ?? "",
              fileName: file?.name ?? "",
            },
      );
    } finally {
      applying = false;
    }
  };
  publish();
  const stopParent = parent.subscribe(publish);
  const stopLocal = store.subscribe((state, previous) => {
    if (applying || state.files === previous.files) return;
    const file = state.files.find((file) => file.id === session.fileId);
    const before = previous.files.find((file) => file.id === session.fileId);
    if (file?.content !== undefined && file.content !== before?.content)
      parent
        .getState()
        .updateFileContent(session.fileId, file.content, before?.content);
  });
  window.addEventListener(
    "unload",
    () => {
      stopParent();
      stopLocal();
    },
    { once: true },
  );
}
