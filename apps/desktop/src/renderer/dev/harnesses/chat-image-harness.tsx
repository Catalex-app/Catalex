import { useEffect } from "react";
import { ChatMessages } from "@/components/agent-chat/chat-messages";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";

const SAMPLE_IMAGE_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5NiIgaGVpZ2h0PSI2NCI+PHJlY3Qgd2lkdGg9Ijk2IiBoZWlnaHQ9IjY0IiByeD0iOCIgZmlsbD0iI2ZkZTI0NyIvPjxjaXJjbGUgY3g9IjQ4IiBjeT0iMzIiIHI9IjE4IiBmaWxsPSIjMTExODI3Ii8+PC9zdmc+";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      convertFileSrc?: (filePath: string, protocol?: string) => string;
    };
  }
}

function ensureDesktopBrowserMocks() {
  if (typeof window === "undefined") return;
  window.__TAURI_INTERNALS__ = {
    ...window.__TAURI_INTERNALS__,
    convertFileSrc: (filePath) =>
      filePath.endsWith("figures/plot.svg") ||
      filePath.includes(".codex/generated_images")
        ? SAMPLE_IMAGE_DATA_URL
        : filePath,
  };
}

function buildMockFiles(): ProjectFile[] {
  return [
    {
      id: "main.tex",
      name: "main.tex",
      relativePath: "main.tex",
      absolutePath: "/tmp/harness/main.tex",
      type: "tex",
      content: "\\documentclass{article}\\begin{document}Hi\\end{document}",
      isDirty: false,
    },
    {
      id: "plot.svg",
      name: "plot.svg",
      relativePath: "figures/plot.svg",
      absolutePath: "/tmp/harness/figures/plot.svg",
      type: "image",
      isDirty: false,
    },
  ];
}

export function ChatImageHarness() {
  ensureDesktopBrowserMocks();

  useEffect(() => {
    const messages = [
      {
        type: "user" as const,
        message: {
          content: [
            {
              type: "text" as const,
              text: "@attachments/crop.png\nCan you inspect this?",
            },
            {
              type: "image" as const,
              imageDataUrl: SAMPLE_IMAGE_DATA_URL,
              alt: "@attachments/crop.png",
            },
          ],
        },
      },
      {
        type: "assistant" as const,
        message: {
          content: [
            {
              type: "text" as const,
              text: "Here is a local markdown image:\n\n![Plot](figures/plot.svg)",
            },
          ],
        },
      },
      {
        type: "assistant" as const,
        message: {
          content: [
            {
              type: "text" as const,
              text: [
                "- Generated Image:",
                "  - Photorealistic cityscape of Shanghai at blue hour.",
                "  - Saved to:",
                "file:///Users/neo/.codex/generated_images/example/generated.png",
              ].join("\n"),
            },
            {
              type: "image" as const,
              imageDataUrl: SAMPLE_IMAGE_DATA_URL,
              alt: "Generated image",
            },
          ],
        },
      },
    ];

    useDocumentStore.setState((state) => ({
      ...state,
      projectRoot: "/tmp/harness",
      files: buildMockFiles(),
      folders: ["figures"],
      activeFileId: "main.tex",
      openFileIds: ["main.tex"],
      initialized: true,
    }));
    useAgentChatStore.setState((state) => ({
      ...state,
      messages,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId ? { ...tab, messages } : tab,
      ),
      isStreaming: false,
    }));
  }, []);

  return (
    <div
      data-testid="chat-image-harness-shell"
      className="h-screen bg-background p-6 text-foreground"
    >
      <div className="relative h-full overflow-hidden rounded-lg border border-border bg-background">
        <ChatMessages />
      </div>
    </div>
  );
}
