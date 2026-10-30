export const MERGE_PREVIEW_REFRESH_EVENT = "catalex:merge-preview-refresh";
export const SHARED_SESSION_SAVED_EVENT = "catalex:shared-session-saved";
// A new range owns the workspace selection; focus changes alone do not.
// Detail "none" explicitly clears both panes, including retained selections.
export const SELECTION_OWNER_EVENT = "catalex:selection-owner";

export const PDF_COMMENT_NAVIGATE_EVENT = "catalex:pdf-comment-navigate";

export const PDF_COMMENT_LAYOUT_EVENT = "catalex:pdf-comment-layout";
export interface PdfCommentLayoutChange {
  editorVisible: boolean;
  exitMs: number;
}
export function preparePdfCommentLayout(
  area: HTMLElement | null,
  editorVisible: boolean,
) {
  const detail: PdfCommentLayoutChange = { editorVisible, exitMs: 0 };
  area?.dispatchEvent(
    new CustomEvent(PDF_COMMENT_LAYOUT_EVENT, { detail, bubbles: true }),
  );
  return detail.exitMs;
}

export const PROJECT_COMMENTS_REFRESH_EVENT =
  "catalex:project-comments-refresh";
export const OPEN_COMMENT_MANAGER_EVENT = "catalex:open-comment-manager";

export const ARTISAN_MODE_REQUEST_EVENT = "catalex:artisan-mode-request";

export const COMMENT_SEARCH_NAVIGATE_EVENT = "catalex:comment-search-navigate";
