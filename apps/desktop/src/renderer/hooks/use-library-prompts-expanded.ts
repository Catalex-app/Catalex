import { areLibraryPromptsExpanded } from "@/lib/prompt-library";
import type { TabState } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";

/** Share the file-aware default across prompt controls and their layout space.
 * Manual choices override it for the current file visit; pinning always wins.
 */
export function useLibraryPromptsExpanded(
  tab: TabState | undefined,
  pinned: boolean,
) {
  const autoExpand = useDocumentStore((state) => {
    const file = state.files.find((item) => item.id === state.activeFileId);
    // A LaTeX preview still has an editable source file. Only standalone
    // non-text files suppress the new-chat default; no-file behavior is unchanged.
    return (
      !file || (!file.isBinary && file.type !== "pdf" && file.type !== "image")
    );
  });
  return areLibraryPromptsExpanded(tab, pinned, autoExpand);
}
