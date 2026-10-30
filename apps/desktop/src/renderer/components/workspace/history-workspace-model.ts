import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import type { SnapshotInfo } from "@/stores/history-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";

/** Read fresh state again when confirming, since review can stay open during agent work. */
export function getHistoryRestoreBlockReason(): string | null {
  const document = useDocumentStore.getState();
  const agent = useAgentChatStore.getState();
  const proposed = useProposedChangesStore.getState();

  if (!document.projectRoot) return "Open a project before restoring history.";
  if (document.isGitOperationRunning)
    return "Wait for the current Git operation to finish before restoring.";
  if (agent.tabs.some((tab) => tab.isStreaming || tab.isSettling))
    return "Wait for the agent to finish before restoring this project.";
  if (document.isApplyingAgentDraft || proposed.workspaceReview?.isApplying)
    return "Wait for the agent's changes to finish applying before restoring.";
  if (proposed.changes.length > 0 || proposed.workspaceReview)
    return "Review the pending agent changes before restoring this project.";
  if (document.agentWorkspaceRoot || document.isAgentWorkspaceReadOnly)
    return "Return to the project workspace before restoring history.";
  if (document.files.some((file) => file.externalChange))
    return "Resolve the files changed on disk before restoring this project.";
  return null;
}

export function snapshotActionName(snapshot: SnapshotInfo): string {
  return (
    snapshot.message.replace(/^\[[^\]]*\]\s*/, "").trim() || "Project snapshot"
  );
}

export function snapshotTitle(snapshot: SnapshotInfo): string {
  return snapshotActionName(snapshot);
}

export function snapshotDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
    .formatToParts(date)
    .map((part) =>
      part.type === "month" ? part.value.toUpperCase() : part.value,
    )
    .join("");
}

/** Display-only category: never a user Git label or a retention pin. */
export function isAgentSnapshot(
  snapshot: Pick<SnapshotInfo, "message">,
): boolean {
  return (
    /^\[(agent|agent-comments|claude|codex)\]/.test(snapshot.message) ||
    /^\[(ask|edit)\] After accepted agent edit$/.test(snapshot.message)
  );
}

export function snapshotAutomaticLabels(
  snapshot: Pick<SnapshotInfo, "message">,
): string[] {
  return [
    ...(isAgentSnapshot(snapshot) ? ["Agent"] : []),
    ...(/^\[(comments|agent-comments)\]/.test(snapshot.message)
      ? ["Comments"]
      : []),
  ];
}

export function snapshotDisplayLabels(snapshot: SnapshotInfo): string[] {
  return [
    ...new Set([...snapshotAutomaticLabels(snapshot), ...snapshot.labels]),
  ];
}

export function labelValidationReason(
  value: string,
  attached: readonly string[] = [],
): string | null {
  const label = value.trim();
  if (!label) return "Enter a label";
  if (label === "Agent" || label === "Comments") return "Reserved label";
  if (attached.includes(label)) return "Already added";
  if (/\p{Cc}/u.test(label)) return "Invalid label";
  if (new TextEncoder().encode(label).length > 256) return "Label is too long";
  return null;
}

export function snapshotLabelOptions(
  counts: Record<string, number>,
  query: string,
  attached: readonly string[] = [],
) {
  return Object.keys(counts)
    .filter(
      (name) =>
        counts[name] > 0 &&
        name.trim() !== "Agent" &&
        name.trim() !== "Comments" &&
        !attached.includes(name) &&
        name.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .map((name) => ({ value: name, label: name }));
}
