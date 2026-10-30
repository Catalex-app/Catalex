import type { AgentMergeSegment } from "./agent-workspace";

/** Document coordinates use LF text, just like CodeMirror. Disk snapshots stay
 * byte-for-byte strings for conflict checks; line endings are encoded at save. */
export function normalizeDocumentText(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function encodeDocumentText(text: string, disk: string): string {
  const ending = disk.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const normalized = normalizeDocumentText(text);
  return ending === "\n" ? normalized : normalized.replace(/\n/g, ending);
}

/** Review versions share editor coordinates; native revision tokens stay opaque. */
export function normalizeReviewText<
  T extends {
    oldContent: string;
    newContent: string;
    conflictContents?: AgentMergeSegment[];
  },
>(change: T): T {
  return {
    ...change,
    oldContent: normalizeDocumentText(change.oldContent),
    newContent: normalizeDocumentText(change.newContent),
    ...(change.conflictContents
      ? {
          conflictContents: change.conflictContents.map((segment) =>
            segment.kind === "resolved"
              ? { ...segment, content: normalizeDocumentText(segment.content) }
              : {
                  ...segment,
                  ancestor: normalizeDocumentText(segment.ancestor),
                  current: normalizeDocumentText(segment.current),
                  agent: normalizeDocumentText(segment.agent),
                },
          ),
        }
      : {}),
  };
}
