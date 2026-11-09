import { useDocumentStore } from "@/stores/document-store";

export function saveFile() {
  const state = useDocumentStore.getState();
  state.setIsSaving(true);
  return state.saveCurrentFile().finally(() => {
    setTimeout(() => state.setIsSaving(false), 500);
  });
}
