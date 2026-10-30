import { type FC, memo, useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { PlusIcon, CopyIcon, CheckIcon } from "lucide-react";
import "katex/dist/katex.min.css";

import { useDocumentStore } from "@/stores/document-store";
import { getAssetUrl } from "@/lib/project-files";
import { normalizeChatMath } from "./normalize-chat-math";
import { ChatImagePreview } from "./chat-image-preview";

// ─── Markdown Renderer ───

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function normalizeMarkdownImagePath(src: string): string {
  const [withoutHash] = src.split("#", 1);
  const [withoutQuery] = withoutHash.split("?", 1);
  return decodeURIComponent(withoutQuery)
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

export const MarkdownRenderer: FC<MarkdownRendererProps> = memo(
  ({ content, className }) => {
    const files = useDocumentStore(
      useShallow((s) => s.files.filter((file) => file.type === "image")),
    );

    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        className={`selectable-content ${className ?? "chat-markdown"}`}
        components={{
          a({ children, href, title }) {
            return (
              <a
                href={href}
                title={title}
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          img({ src, alt }) {
            if (!src) return null;

            const isDirectSrc =
              src.startsWith("data:") ||
              src.startsWith("blob:") ||
              src.startsWith("asset:") ||
              src.startsWith("http://") ||
              src.startsWith("https://");
            const imageFile = isDirectSrc
              ? null
              : files.find(
                  (file) =>
                    file.type === "image" &&
                    file.relativePath.replace(/\\/g, "/") ===
                      normalizeMarkdownImagePath(src),
                );
            const resolvedSrc = imageFile
              ? getAssetUrl(imageFile.absolutePath)
              : src;

            return (
              <ChatImagePreview
                src={resolvedSrc}
                alt={alt ?? ""}
                thumbnailClassName="my-2 max-h-80"
              />
            );
          },
          code({ className: codeClassName, children, node, ...props }) {
            const match = /language-(\w+)/.exec(codeClassName || "");
            const language = match?.[1];
            const code = String(children).replace(/\n$/, "");
            const isBlock =
              node?.position &&
              node.position.start.line !== node.position.end.line;

            if (!match && !isBlock) {
              return (
                <code className={codeClassName} {...props}>
                  {children}
                </code>
              );
            }

            return <CodeBlock language={language || ""} code={code} />;
          },
        }}
      >
        {normalizeChatMath(content)}
      </ReactMarkdown>
    );
  },
);

// ─── Code Block ───

const CodeBlock: FC<{ language: string; code: string }> = ({
  language,
  code,
}) => {
  const insertAtCursor = useDocumentStore((s) => s.insertAtCursor);
  const isLatex = language === "latex" || language === "tex";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const handleInsert = useCallback(() => {
    insertAtCursor(code);
  }, [insertAtCursor, code]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="not-prose group relative my-2">
      <pre className="app-scrollbar overflow-x-auto rounded bg-muted p-3 text-sm">
        <code>{code}</code>
      </pre>
      <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        {isLatex && (
          <button
            type="button"
            onClick={handleInsert}
            className="flex items-center gap-0.5 rounded bg-primary px-1.5 py-0.5 text-primary-foreground text-xs"
          >
            <PlusIcon className="size-3" />
            Insert
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-0.5 rounded border border-border bg-background px-1.5 py-0.5 text-foreground text-xs hover:bg-muted"
          aria-live="polite"
        >
          {copyState === "copied" ? (
            <CheckIcon className="size-3" />
          ) : (
            <CopyIcon className="size-3" />
          )}
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Copy failed"
              : "Copy"}
        </button>
      </div>
    </div>
  );
};
