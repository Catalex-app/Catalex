export interface ChatContextBadge {
  label: string;
  filePath: string;
  selectedText: string;
  selectionPinned?: boolean;
  selectionKey?: string;
  imageDataUrl?: string;
  attachment?: boolean;
  proposedDraft?: { sessionId: string; contentVersion?: string };
  comment?: {
    id: string;
    agent: boolean;
    text: string;
    label?: string;
    resolved?: boolean;
    line?: number;
    from?: number;
    to?: number;
  };
}

export function isSelectionRangeContextLabel(label: string): boolean {
  return (
    /:\d+:\d+-\d+:\d+(?: · PDF p\.\d+)?$/.test(label) ||
    /^PDF (?:p\.\d+ · “.*”|· p\. \d+)$/.test(label)
  );
}

/** Single-context callers and saved paused requests remain supported. */
export type ChatPromptContext =
  | ChatContextBadge[]
  | (ChatContextBadge & { imageDataUrls?: string[] });

export function chatContextItems(
  context?: ChatPromptContext,
): Array<ChatContextBadge & { imageDataUrls?: string[] }> {
  return !context ? [] : Array.isArray(context) ? context : [context];
}

/** Stable identity for a captured text version; never used as an authorization hash. */
export function draftContentVersion(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  }
  return `${content.length}:${hash >>> 0}`;
}

export function captureProposedDraft(
  sessionId: string | null,
  content?: string,
) {
  return sessionId
    ? {
        sessionId,
        contentVersion:
          content === undefined ? undefined : draftContentVersion(content),
      }
    : undefined;
}

export function isEarlierDraftContext(
  context: ChatContextBadge,
  sessionId: string | null,
  content?: string,
): boolean {
  const draft = context.proposedDraft;
  return Boolean(
    draft &&
      (draft.sessionId !== sessionId ||
        (draft.contentVersion !== undefined &&
          (content === undefined ||
            draft.contentVersion !== draftContentVersion(content)))),
  );
}
