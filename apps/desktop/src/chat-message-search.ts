import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import {
  findPreviewMatches,
  PREVIEW_SEARCH_LIMIT,
  type PreviewSearchQuery,
} from "./renderer/lib/preview-search";

export interface ChatSearchMessage {
  type: string;
  result?: string;
  errors?: string[];
  message?: { content?: string | { type: string; text?: string }[] };
}

export interface ChatMessageMatch {
  messageIndex: number;
  count: number;
}

export interface SavedChatMatches {
  matches: ChatMessageMatch[];
  total: number;
  truncated: boolean;
}

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
const messageText = new WeakMap<ChatSearchMessage, string>();

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

function plainText(node: MarkdownNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(plainText).join("");
}

export function searchableMessageText(message: ChatSearchMessage) {
  const cached = messageText.get(message);
  if (cached !== undefined) return cached;
  const content = message.message?.content;
  const source =
    message.type === "result"
      ? message.errors?.join("\n") || message.result || ""
      : typeof content === "string"
        ? content
        : (content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n\n");
  const tree = markdown.runSync(markdown.parse(source));
  const result = plainText(tree);
  messageText.set(message, result);
  return result;
}

export function chatMessageMatchCount(
  message: ChatSearchMessage,
  query: PreviewSearchQuery,
) {
  if (
    message.type !== "user" &&
    message.type !== "assistant" &&
    message.type !== "result"
  )
    return 0;
  return findPreviewMatches(searchableMessageText(message), query).length;
}

/** Accumulate positions while checkpoint chunks are read one at a time. */
export function collectChatMatches(query: PreviewSearchQuery) {
  const matches: ChatMessageMatch[] = [];
  const assistantTexts = new Set<string>();
  let remaining = PREVIEW_SEARCH_LIMIT;
  return {
    matches,
    add(message: ChatSearchMessage, messageIndex: number) {
      if (
        message.type === "result" &&
        message.result &&
        assistantTexts.has(message.result.trim())
      )
        return true;
      const count = chatMessageMatchCount(message, query);
      if (!count) return true;
      if (
        message.type === "assistant" &&
        Array.isArray(message.message?.content)
      )
        for (const block of message.message.content)
          if (block.type === "text" && block.text)
            assistantTexts.add(block.text.trim());
      if (remaining > 0)
        matches.push({ messageIndex, count: Math.min(remaining, count) });
      remaining -= count;
      return remaining >= 0;
    },
  };
}
