import React from "react";
import type { Root } from "react-dom/client";

export async function renderDebugWindow(
  root: Pick<Root, "render">,
  debugMode: string | null,
) {
  if (debugMode === "project-navigation") {
    const { initializeProjectNavigationHarness } = await import(
      "./harnesses/project-navigation-harness"
    );
    initializeProjectNavigationHarness();
    const { App } = await import("../App");
    root.render(<App />);
    return;
  }
  if (debugMode === "updater") {
    const { UpdaterHarness } = await import("./harnesses/updater-harness");
    root.render(<UpdaterHarness />);
    return;
  }
  if (debugMode === "editor-minimap") {
    const { EditorMinimapHarness } = await import(
      "./harnesses/editor-minimap-harness"
    );
    root.render(<EditorMinimapHarness />);
    return;
  }
  if (debugMode === "git-three-way") {
    const { GitThreeWayDemo } = await import("./harnesses/git-three-way-demo");
    root.render(<GitThreeWayDemo />);
    return;
  }
  if (debugMode === "agent-three-way") {
    const { AgentThreeWayDemo } = await import(
      "./harnesses/agent-three-way-demo"
    );
    root.render(<AgentThreeWayDemo />);
    return;
  }
  if (debugMode === "agent-file-review") {
    const { AgentFileReviewDemo } = await import(
      "./harnesses/agent-file-review-demo"
    );
    root.render(<AgentFileReviewDemo />);
    return;
  }
  if (debugMode === "focus") {
    const { FocusHarness } = await import("./harnesses/focus-harness");
    root.render(<FocusHarness />);
    return;
  }
  if (debugMode === "comment-workspace") {
    const { CommentWorkspaceDemo } = await import(
      "./harnesses/comment-workspace-demo"
    );
    root.render(<CommentWorkspaceDemo />);
    return;
  }
  if (debugMode === "context-menu") {
    const { ContextMenuHarness } = await import(
      "./harnesses/context-menu-harness"
    );
    root.render(<ContextMenuHarness />);
    return;
  }
  if (debugMode === "tooltips") {
    const { TooltipHarness } = await import("./harnesses/tooltip-harness");
    root.render(<TooltipHarness />);
    return;
  }
  if (debugMode === "history-workspace") {
    const { HistoryWorkspaceHarness } = await import(
      "./harnesses/history-workspace-harness"
    );
    root.render(
      <React.StrictMode>
        <HistoryWorkspaceHarness />
      </React.StrictMode>,
    );
    return;
  }
  if (debugMode === "git-credentials") {
    const { GitCredentialHarness } = await import(
      "./harnesses/git-credential-harness"
    );
    root.render(<GitCredentialHarness />);
    return;
  }
  if (debugMode === "agent-concurrency") {
    const { AgentConcurrencyHarness } = await import(
      "./harnesses/agent-concurrency-harness"
    );
    root.render(<AgentConcurrencyHarness />);
    return;
  }
  if (debugMode === "session-navigation") {
    const { SessionNavigationHarness } = await import(
      "./harnesses/session-navigation-harness"
    );
    root.render(<SessionNavigationHarness />);
    return;
  }
  if (debugMode === "pdf-comments") {
    const { PdfCommentsHarness } = await import(
      "./harnesses/pdf-comments-harness"
    );
    root.render(<PdfCommentsHarness />);
    return;
  }
  if (debugMode === "agent-pause") {
    const { AgentPauseHarness } = await import(
      "./harnesses/agent-pause-harness"
    );
    root.render(<AgentPauseHarness />);
    return;
  }
  if (debugMode === "claude-models") {
    const { ClaudeModelsHarness } = await import(
      "./harnesses/claude-models-harness"
    );
    root.render(<ClaudeModelsHarness />);
    return;
  }
  // Debug window — render debug tools
  if (debugMode === "git-buffers") {
    const { GitBufferHarness } = await import("./harnesses/git-buffer-harness");
    root.render(<GitBufferHarness />);
    return;
  }
  if (debugMode === "storage-settings") {
    const { StorageSettingsHarness } = await import(
      "./harnesses/storage-settings-harness"
    );
    root.render(<StorageSettingsHarness />);
    return;
  }
  if (debugMode === "markdown-settings") {
    const { MarkdownSettingsHarness } = await import(
      "./harnesses/markdown-settings-harness"
    );
    root.render(
      <React.StrictMode>
        <MarkdownSettingsHarness />
      </React.StrictMode>,
    );
    return;
  }
  const DebugComponent =
    debugMode === "sidebar-animation"
      ? (await import("./harnesses/sidebar-animation-harness"))
          .SidebarAnimationHarness
      : debugMode === "input-transfer"
        ? (await import("./harnesses/input-transfer-harness"))
            .InputTransferHarness
        : debugMode === "editor-search"
          ? (await import("./harnesses/editor-search-harness"))
              .EditorSearchHarness
          : debugMode === "editor-scroll"
            ? (await import("./harnesses/editor-scroll-harness"))
                .EditorScrollHarness
            : debugMode === "editor-diff"
              ? (await import("./harnesses/editor-diff-harness"))
                  .EditorDiffHarness
              : debugMode === "latex-multifile-scroll-sync"
                ? (await import("./harnesses/latex-scroll-sync-harness"))
                    .LatexMultiFileScrollSyncHarness
                : debugMode === "latex-scroll-sync"
                  ? (await import("./harnesses/latex-scroll-sync-harness"))
                      .LatexScrollSyncHarness
                  : debugMode === "markdown-preview"
                    ? (await import("./harnesses/markdown-preview-harness"))
                        .MarkdownPreviewHarness
                    : debugMode === "markdown-workspace"
                      ? (await import("./harnesses/markdown-preview-harness"))
                          .MarkdownWorkspaceHarness
                      : debugMode === "external-files"
                        ? (await import("./harnesses/external-files-harness"))
                            .ExternalFilesHarness
                        : debugMode === "editor-comments"
                          ? (
                              await import(
                                "./harnesses/editor-comments-harness"
                              )
                            ).EditorCommentsHarness
                          : debugMode === "git-actions"
                            ? (await import("./harnesses/git-actions-harness"))
                                .GitActionsHarness
                            : debugMode === "chat-images"
                              ? (await import("./harnesses/chat-image-harness"))
                                  .ChatImageHarness
                              : debugMode === "chat-branching"
                                ? (
                                    await import(
                                      "./harnesses/chat-branching-harness"
                                    )
                                  ).ChatBranchingHarness
                                : debugMode === "agent-activity"
                                  ? (
                                      await import(
                                        "./harnesses/agent-activity-harness"
                                      )
                                    ).AgentActivityHarness
                                  : debugMode === "agent-verify-skill"
                                    ? (
                                        await import(
                                          "./harnesses/agent-verify-skill-harness"
                                        )
                                      ).AgentVerifySkillHarness
                                    : debugMode === "pdf-preview"
                                      ? (
                                          await import(
                                            "./harnesses/pdf-preview-harness"
                                          )
                                        ).PdfPreviewHarness
                                      : debugMode === "history-management"
                                        ? (
                                            await import(
                                              "./harnesses/history-management-harness"
                                            )
                                          ).HistoryManagementHarness
                                        : debugMode === "csv-workspace"
                                          ? (
                                              await import(
                                                "./harnesses/csv-workspace-harness"
                                              )
                                            ).CsvWorkspaceHarness
                                          : debugMode === "new-project"
                                            ? (
                                                await import(
                                                  "./harnesses/new-project-harness"
                                                )
                                              ).NewProjectHarness
                                            : (
                                                await import(
                                                  "../components/debug/debug-page"
                                                )
                                              ).DebugPage;
  root.render(
    <React.StrictMode>
      <DebugComponent />
    </React.StrictMode>,
  );
  return;
}
