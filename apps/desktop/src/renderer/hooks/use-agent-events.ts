import { PRODUCT_NAME } from "../../branding";
import { retireAgentDraft } from "@/lib/retire-agent-draft";
import { HARNESSES } from "@/lib/agent-harness";
import {
  beginCompilation,
  isCurrentCompilation,
  publishCompilation,
  failCompilation,
  finishCompilation,
  type Compilation,
} from "@/lib/workspace-compile";
import { useEffect, useRef } from "react";
import { useAgentCommentReveal } from "./use-agent-comment-reveal";
import { listen, type UnlistenFn } from "@/lib/desktop/event";
import { invoke } from "@/lib/desktop/core";
import {
  useAgentQuestionStore,
  type AgentQuestion,
} from "@/stores/agent-question-store";
import {
  commentSourceMatches,
  type CommentSourceCheck,
} from "@/lib/comment-source-check";
import {
  useAgentChatStore,
  type AgentActivity,
  type AgentStreamMessage,
  type ChatProvider,
} from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getAssetUrl } from "@/lib/project-files";
import {
  type CompileDiagnostic,
  compileLatex,
  detectTexEngineFromContent,
  resolveCompileTarget,
  formatCompileError,
} from "@/lib/latex-compiler";
import { createLogger } from "@/lib/debug/logger";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { getOrOpenDocument } from "@/lib/mupdf/pdf-doc-cache";
import { reconcileAgentWorkspace } from "@/lib/agent-workspace";
import {
  claudeProviderStatus,
  readCodexProviderStatus,
} from "@/lib/agent-provider-status";

const log = createLogger("agent-events");

/** Backend event payload shapes (include tab_id for routing) */
interface ProviderOutputPayload {
  tab_id: string;
  data: string;
}

interface ProviderCompletePayload {
  tab_id: string;
  success: boolean;
}

interface ProviderErrorPayload {
  tab_id: string;
  data: string;
}

interface CodexFinalPayload {
  tab_id: string;
  data: string;
  item_id?: string | null;
}

interface VerificationCompilePayload {
  request_id: string;
  tab_id: string;
  project_path: string;
  root_id: string;
  main_file: string;
  backend: string;
  engine: string;
  status: "started" | "succeeded" | "failed" | "cancelled";
  diagnostics?: CompileDiagnostic[];
  duration_ms?: number | null;
  error?: string | null;
}

interface VerificationRenderPagePayload {
  request_id: string;
  tab_id: string;
  project_path: string;
  root_id: string;
  pages: number[];
  target_width: number;
}

interface VerificationRenderedPageReply {
  page: number;
  width: number;
  height: number;
  imageDataUrl: string;
}

type VerificationRenderPageReply =
  | {
      status: "success";
      pageCount: number;
      pages: VerificationRenderedPageReply[];
    }
  | {
      status: "error";
      code:
        | "missing_pdf"
        | "invalid_page"
        | "render_failed"
        | "image_too_large";
      message: string;
      pageCount?: number;
    };

interface ProviderActivityPayload {
  tab_id: string;
  kind: AgentActivity["kind"];
  item_id: string;
  text?: string | null;
  name?: string | null;
  input?: unknown;
  content?: unknown;
  is_error?: boolean | null;
}

interface ClaudePartialBlockState {
  type: "text" | "thinking" | "tool_use";
  toolId?: string;
  toolName?: string;
  partialJson: string;
}

interface ClaudePartialMessageState {
  blocks: Map<number, ClaudePartialBlockState>;
  renderedAny: boolean;
}

function getCodexThreadId(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const item = message as Record<string, any>;
  const direct =
    typeof item.thread_id === "string"
      ? item.thread_id
      : typeof item.threadId === "string"
        ? item.threadId
        : typeof item.session_id === "string"
          ? item.session_id
          : null;
  if (direct) return direct;

  const thread = item.thread;
  if (thread && typeof thread === "object" && typeof thread.id === "string") {
    return thread.id;
  }

  const resultThread = item.result?.thread;
  if (
    resultThread &&
    typeof resultThread === "object" &&
    typeof resultThread.id === "string"
  ) {
    return resultThread.id;
  }

  return null;
}

const IMAGE_FILE_URL_PATTERN =
  /file:\/\/(?:localhost)?(\/[^\s<>"')]+?\.(?:png|jpe?g|gif|webp|bmp|svg))/gi;

const MAX_VERIFICATION_RENDER_IMAGE_DATA_URL_BYTES = 8 * 1024 * 1024;
const MAX_VERIFICATION_RENDER_ERROR_CHARS = 1_000;

function boundedRenderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message)
    .slice(0, MAX_VERIFICATION_RENDER_ERROR_CHARS)
    .join("");
}

function pngDimensions(pngBytes: Uint8Array): {
  width: number;
  height: number;
} {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    pngBytes.byteLength < 24 ||
    signature.some((byte, index) => pngBytes[index] !== byte)
  ) {
    throw new Error("MuPDF returned an invalid PNG image");
  }
  const view = new DataView(
    pngBytes.buffer,
    pngBytes.byteOffset,
    pngBytes.byteLength,
  );
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) {
    throw new Error("MuPDF returned an empty PNG image");
  }
  return { width, height };
}

function pngDataUrl(pngBytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < pngBytes.byteLength; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(
        ...pngBytes.subarray(
          offset,
          Math.min(offset + chunkSize, pngBytes.length),
        ),
      ),
    );
  }
  return `data:image/png;base64,${btoa(chunks.join(""))}`;
}

function fileUrlToPath(fileUrl: string): string | null {
  try {
    const url = new URL(fileUrl);
    if (url.protocol !== "file:") return null;
    return decodeURIComponent(url.pathname);
  } catch {
    const match = fileUrl.match(/^file:\/\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function extractImageFileUrls(text: string): string[] {
  IMAGE_FILE_URL_PATTERN.lastIndex = 0;
  const imageUrls = Array.from(text.matchAll(IMAGE_FILE_URL_PATTERN))
    .map((match) => match[0])
    .filter((url, index, urls) => urls.indexOf(url) === index);
  IMAGE_FILE_URL_PATTERN.lastIndex = 0;
  return imageUrls;
}

function assistantMessageContainsFileUrl(
  message: AgentStreamMessage | undefined,
  fileUrl: string,
): boolean {
  if (!message?.message?.content) return false;
  return message.message.content.some((block) => {
    if (block.type === "text") return block.text?.includes(fileUrl) ?? false;
    if (block.type === "image")
      return block.imageDataUrl?.includes(fileUrl) ?? false;
    return false;
  });
}

function assistantMessageFromCodexText(text: string): AgentStreamMessage {
  const imageUrls = extractImageFileUrls(text);

  if (imageUrls.length === 0) {
    return {
      type: "assistant",
      message: {
        content: [{ type: "text", text }],
      },
    } as AgentStreamMessage;
  }

  const content = imageUrls
    .map((fileUrl, index) => {
      const filePath = fileUrlToPath(fileUrl);
      if (!filePath) return null;
      return {
        type: "image" as const,
        imageDataUrl: getAssetUrl(filePath),
        imageFilePath: filePath,
        alt:
          imageUrls.length === 1
            ? "Generated image"
            : `Generated image ${index + 1}`,
      };
    })
    .filter((block): block is NonNullable<typeof block> => block !== null);

  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text }, ...content],
    },
  } as AgentStreamMessage;
}

/**
 * Hook that manages desktop event listeners for provider CLI streaming output.
 *
 * Listeners are kept alive at all times (no race condition with invoke).
 * Per-tab mutable state (pendingToolUses, hasTexChanges) is stored in Maps
 * keyed by tab_id so multiple tabs can stream concurrently.
 */
export function useAgentEvents() {
  useAgentCommentReveal();
  // Per-tab mutable state stored in refs so the long-lived listeners
  // always read the latest values without needing to be re-created.
  const pendingToolUsesRef = useRef(
    new Map<string, Map<string, { name: string; input: any }>>(),
  );
  const hasTexChangesRef = useRef(new Map<string, boolean>());
  const cancelledForAskRef = useRef(new Map<string, boolean>());
  const listenersRef = useRef<UnlistenFn[]>([]);
  const msgCountRef = useRef(new Map<string, number>());
  const streamStartTimeRef = useRef(new Map<string, number>());
  const lastMsgTimeRef = useRef(new Map<string, number>());
  const codexPlainOutputRef = useRef(new Map<string, string[]>());
  const claudePartialMessagesRef = useRef(
    new Map<string, Map<string, ClaudePartialMessageState>>(),
  );

  // Reset per-tab state whenever any tab starts streaming
  const tabs = useAgentChatStore((s) => s.tabs);
  useEffect(() => {
    useAgentQuestionStore.getState().prune();
    for (const tab of tabs) {
      if (tab.isStreaming && !msgCountRef.current.has(tab.id)) {
        // New stream detected for this tab — initialize state
        pendingToolUsesRef.current.set(tab.id, new Map());
        hasTexChangesRef.current.set(tab.id, false);
        cancelledForAskRef.current.set(tab.id, false);
        msgCountRef.current.set(tab.id, 0);
        streamStartTimeRef.current.delete(tab.id);
        lastMsgTimeRef.current.delete(tab.id);
        codexPlainOutputRef.current.set(tab.id, []);
        claudePartialMessagesRef.current.set(tab.id, new Map());
      } else if (!tab.isStreaming) {
        // Clean up finished tab state
        msgCountRef.current.delete(tab.id);
        streamStartTimeRef.current.delete(tab.id);
        lastMsgTimeRef.current.delete(tab.id);
        codexPlainOutputRef.current.delete(tab.id);
        claudePartialMessagesRef.current.delete(tab.id);
      }
    }
  }, [tabs]);

  // ── One-time listener setup (mount only) ──
  useEffect(() => {
    function elapsed(tabId: string) {
      const start = streamStartTimeRef.current.get(tabId);
      if (!start) return "";
      return `+${((performance.now() - start) / 1000).toFixed(1)}s`;
    }

    const verificationCompiles = new Map<string, Compilation>();
    async function handleVerificationCompile(
      payload: VerificationCompilePayload,
    ) {
      const state = useDocumentStore.getState();
      if (payload.status === "started") {
        if (
          (state.agentWorkspaceRoot ?? state.projectRoot) !==
          payload.project_path
        )
          return;
        // Keep the token until its terminal event, even if publication becomes stale.
        const request = beginCompilation(payload.root_id);
        if (request) verificationCompiles.set(payload.request_id, request);
        return;
      }
      const request = verificationCompiles.get(payload.request_id);
      verificationCompiles.delete(payload.request_id);
      if (!request) return;
      try {
        if (payload.status === "cancelled" || !isCurrentCompilation(request))
          return;
        if (payload.status === "failed") {
          failCompilation(request, {
            message: payload.error ?? "Compilation failed",
            diagnostics: payload.diagnostics,
          });
          return;
        }
        const buffer = await invoke<ArrayBuffer | number[] | null>(
          "get_compiled_pdf",
          { projectDir: payload.project_path, requestId: payload.request_id },
        );
        if (buffer === null) return;
        publishCompilation(
          request,
          new Uint8Array(buffer),
          payload.diagnostics,
        );
      } catch (error) {
        failCompilation(request, error);
      } finally {
        finishCompilation(request);
      }
    }

    async function sendVerificationRenderReply(
      requestId: string,
      result: VerificationRenderPageReply,
    ) {
      try {
        await invoke("resolve_verification_render_request", {
          requestId,
          result,
        });
      } catch (error) {
        log.warn(
          `Failed to resolve ${PRODUCT_NAME} PDF render request ${requestId}: ${boundedRenderError(error)}`,
        );
      }
    }

    async function handleVerificationRenderPage(
      payload: VerificationRenderPagePayload,
    ) {
      if (
        !payload.request_id ||
        !Array.isArray(payload.pages) ||
        payload.pages.length === 0 ||
        !Number.isInteger(payload.target_width) ||
        payload.target_width < 1
      ) {
        if (payload.request_id) {
          await sendVerificationRenderReply(payload.request_id, {
            status: "error",
            code: "render_failed",
            message: PRODUCT_NAME + " received an invalid PDF render request",
          });
        }
        return;
      }

      let pdfBuffer: ArrayBuffer | number[];
      try {
        pdfBuffer = await invoke<ArrayBuffer | number[]>("get_compiled_pdf", {
          projectDir: payload.project_path,
        });
      } catch (error) {
        await sendVerificationRenderReply(payload.request_id, {
          status: "error",
          code: "missing_pdf",
          message: boundedRenderError(error),
        });
        return;
      }

      try {
        const pdfData = new Uint8Array(pdfBuffer);
        if (pdfData.byteLength === 0) {
          throw new Error("The latest compiled PDF is empty");
        }
        const { docId, pageSizes } = await getOrOpenDocument(pdfData);
        const invalidPages = payload.pages.filter(
          (page) =>
            !Number.isInteger(page) || page < 1 || page > pageSizes.length,
        );
        if (invalidPages.length > 0) {
          await sendVerificationRenderReply(payload.request_id, {
            status: "error",
            code: "invalid_page",
            message: `Requested page ${invalidPages.join(", ")}; the compiled PDF has ${pageSizes.length} page(s)`,
            pageCount: pageSizes.length,
          });
          return;
        }

        const client = getMupdfClient();
        const renderedPages: VerificationRenderedPageReply[] = [];
        for (const page of payload.pages) {
          const pngBuffer = await client.renderThumbnail(
            docId,
            page - 1,
            payload.target_width,
          );
          const pngBytes = new Uint8Array(pngBuffer);
          const { width, height } = pngDimensions(pngBytes);
          const imageDataUrl = pngDataUrl(pngBytes);
          if (
            imageDataUrl.length > MAX_VERIFICATION_RENDER_IMAGE_DATA_URL_BYTES
          ) {
            await sendVerificationRenderReply(payload.request_id, {
              status: "error",
              code: "image_too_large",
              message: `The rendered image for page ${page} exceeds ${PRODUCT_NAME}'s size limit`,
              pageCount: pageSizes.length,
            });
            return;
          }
          renderedPages.push({ page, width, height, imageDataUrl });
        }

        await sendVerificationRenderReply(payload.request_id, {
          status: "success",
          pageCount: pageSizes.length,
          pages: renderedPages,
        });
      } catch (error) {
        await sendVerificationRenderReply(payload.request_id, {
          status: "error",
          code: "render_failed",
          message: boundedRenderError(error),
        });
      }
    }

    const completingTabs = new Set<string>();

    async function handlePostComplete(
      tabId: string,
      success: boolean,
      provider: ChatProvider,
    ) {
      const chatStore = useAgentChatStore.getState();
      const tab = chatStore.tabs.find((t) => t.id === tabId);
      if (
        !tab?.isStreaming ||
        tab.provider !== provider ||
        completingTabs.has(tabId)
      ) {
        log.warn(
          `[${tabId}] ignoring duplicate complete event for ${provider} (not streaming)`,
        );
        return;
      }
      if (tab.compacting) {
        chatStore._finishCompaction(tabId, success);
        return;
      }
      chatStore._finishRoundTiming(tabId);
      chatStore._setProviderStatus(tabId, provider, null);
      completingTabs.add(tabId);
      useAgentChatStore.setState((state) => ({
        tabs: state.tabs.map((item) =>
          item.id === tabId ? { ...item, isSettling: true } : item,
        ),
      }));
      try {
        const workspace = tab.agentWorkspace;
        const wasCancelled = tab.cancelledByUser === true;
        const wasCancelledForAsk =
          cancelledForAskRef.current.get(tabId) ?? false;

        const interrupted = !success && !wasCancelled && !wasCancelledForAsk;
        if (interrupted && !tab.error) {
          chatStore._setError(
            tabId,
            `${HARNESSES[provider].label} request failed without an error message.`,
          );
        }
        if (tab.pauseState === "pausing" || interrupted) {
          completingTabs.add(tabId);
          try {
            pendingToolUsesRef.current.delete(tabId);
            hasTexChangesRef.current.delete(tabId);
            cancelledForAskRef.current.delete(tabId);
            // A paused draft remains active. Reconciliation would turn it into a
            // review (or delete an empty draft), preventing a same-workspace resume.
            if (!interrupted) chatStore._markProviderSynced(tabId, provider);
            chatStore._setStreaming(tabId, false, interrupted);
            await chatStore._syncSharedSession(tabId);
            if (
              useAgentChatStore.getState().activeTabId === tabId &&
              useDocumentStore.getState().projectRoot === workspace?.projectRoot
            ) {
              await useDocumentStore
                .getState()
                .refreshFiles()
                .catch((error) => {
                  chatStore._setError(
                    tabId,
                    `The agent paused, but refreshing the draft failed: ${String(error)}`,
                  );
                });
            }
          } finally {
            completingTabs.delete(tabId);
          }
          return;
        }

        pendingToolUsesRef.current.delete(tabId);
        hasTexChangesRef.current.delete(tabId);
        cancelledForAskRef.current.delete(tabId);
        chatStore._setStreaming(tabId, false);

        if (success) {
          chatStore._markProviderSynced(tabId, provider);
        }

        if (wasCancelledForAsk && !wasCancelled) {
          await chatStore._syncSharedSession(tabId);
          return;
        }

        if (!workspace) {
          if (success) await useDocumentStore.getState().refreshFiles();
          await chatStore._syncSharedSession(tabId);
          chatStore._setPendingFileBaseline(tabId, null);
          return;
        }

        const outcome = success
          ? "success"
          : wasCancelled
            ? "cancelled"
            : "failed";
        try {
          const reconciliation = await reconcileAgentWorkspace(
            workspace.projectRoot,
            workspace.sessionId,
            outcome,
          );
          chatStore._setAgentWorkspace(tabId, reconciliation.session);

          if (reconciliation.changes.length === 0) {
            const { useAgentReviewQueueStore } = await import(
              "@/stores/agent-review-queue-store"
            );
            await retireAgentDraft(reconciliation.session);
            await useAgentReviewQueueStore
              .getState()
              .finish(workspace.sessionId);
          } else {
            let verificationError: string | undefined;
            if (success) {
              const { files, activeFileId } = useDocumentStore.getState();
              const resolved =
                tab.agentVerificationContext ??
                resolveCompileTarget(activeFileId, files);
              if (resolved) {
                const { rootId, targetPath } = resolved;
                try {
                  const compilerChoice = tab.agentVerificationContext;
                  const { backend, engine, autoEngine } =
                    compilerChoice ??
                    (() => {
                      const rootFile = files.find((file) => file.id === rootId);
                      const detectedEngine = rootFile?.content
                        ? detectTexEngineFromContent(rootFile.content)
                        : null;
                      return useSettingsStore
                        .getState()
                        .initializeCompilerChoiceForRoot(
                          workspace.projectRoot,
                          rootId,
                          detectedEngine,
                        );
                    })();
                  await compileLatex(
                    workspace.candidateRoot,
                    targetPath,
                    backend,
                    engine,
                    autoEngine,
                  );
                } catch (error) {
                  verificationError = `The agent draft did not compile. The source project was not changed; the draft is available for review. ${formatCompileError(error)}`;
                  chatStore._setError(tabId, verificationError);
                }
              }
            }

            const { useAgentReviewQueueStore } = await import(
              "@/stores/agent-review-queue-store"
            );
            await useAgentReviewQueueStore
              .getState()
              .enqueue(reconciliation.session, verificationError);
          }
        } catch (error) {
          const { useAgentReviewQueueStore } = await import(
            "@/stores/agent-review-queue-store"
          );
          await useAgentReviewQueueStore
            .getState()
            .recoverRefinement(workspace.sessionId);
          useDocumentStore.getState().setAgentWorkspaceReadOnly(false);
          chatStore._setError(
            tabId,
            `The isolated draft could not be reconciled. The source project was not changed. ${String(error)}`,
          );
        }

        await chatStore._syncSharedSession(tabId);
        chatStore._setPendingFileBaseline(tabId, null);
      } finally {
        completingTabs.delete(tabId);
        useAgentChatStore.setState((state) => ({
          tabs: state.tabs.map((item) =>
            item.id === tabId ? { ...item, isSettling: false } : item,
          ),
        }));
        const current = useAgentChatStore.getState();
        if (
          success &&
          !tab.cancelledByUser &&
          !tab.pauseState &&
          current.tabs.find((item) => item.id === tabId)?.queuedPrompts?.length
        )
          void current._runNextQueuedPrompt(tabId);
      }
    }

    function applyActivity(tabId: string, activity: AgentActivity) {
      useAgentChatStore.getState()._applyActivity(tabId, activity);
    }

    function getClaudePartialMessage(
      tabId: string,
      uuid: string,
    ): ClaudePartialMessageState {
      let tabMessages = claudePartialMessagesRef.current.get(tabId);
      if (!tabMessages) {
        tabMessages = new Map();
        claudePartialMessagesRef.current.set(tabId, tabMessages);
      }
      let partial = tabMessages.get(uuid);
      if (!partial) {
        partial = { blocks: new Map(), renderedAny: false };
        tabMessages.set(uuid, partial);
      }
      return partial;
    }

    function handleClaudePartialMessage(
      tabId: string,
      message: Record<string, any>,
    ): boolean {
      if (message.type !== "stream_event") return false;
      const uuid = typeof message.uuid === "string" ? message.uuid : null;
      const event = message.event;
      if (!uuid || !event || typeof event !== "object") return true;

      const partial = getClaudePartialMessage(tabId, uuid);
      const index = typeof event.index === "number" ? event.index : -1;

      if (event.type === "content_block_start" && index >= 0) {
        const block = event.content_block;
        if (!block || typeof block !== "object") return true;
        if (block.type === "tool_use" && typeof block.id === "string") {
          const blockState: ClaudePartialBlockState = {
            type: "tool_use",
            toolId: block.id,
            toolName:
              typeof block.name === "string" ? block.name : "ClaudeTool",
            partialJson: "",
          };
          partial.blocks.set(index, blockState);
          partial.renderedAny = true;
          applyActivity(tabId, {
            kind: "tool_started",
            id: block.id,
            name: blockState.toolName,
            input:
              block.input && typeof block.input === "object" ? block.input : {},
          });
        } else if (block.type === "thinking" || block.type === "text") {
          partial.blocks.set(index, {
            type: block.type,
            partialJson: "",
          });
        }
        return true;
      }

      if (event.type === "content_block_delta" && index >= 0) {
        const block = partial.blocks.get(index);
        const delta = event.delta;
        if (!block || !delta || typeof delta !== "object") return true;
        const activityId = `${uuid}:${index}`;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          partial.renderedAny = true;
          applyActivity(tabId, {
            kind: "text_delta",
            id: activityId,
            text: delta.text,
          });
        } else if (
          delta.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        ) {
          partial.renderedAny = true;
          applyActivity(tabId, {
            kind: "thinking_delta",
            id: activityId,
            text: delta.thinking,
          });
        } else if (
          block.type === "tool_use" &&
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          block.partialJson += delta.partial_json;
          try {
            const input = JSON.parse(block.partialJson);
            applyActivity(tabId, {
              kind: "tool_started",
              id: block.toolId!,
              name: block.toolName,
              input,
            });
          } catch {
            // Tool input is expected to be incomplete until the block ends.
          }
        }
      }

      return true;
    }

    function finalizeClaudePartialMessage(
      tabId: string,
      message: AgentStreamMessage,
    ): boolean {
      if (message.type !== "assistant" || !message.uuid) return false;
      const tabMessages = claudePartialMessagesRef.current.get(tabId);
      const partial = tabMessages?.get(message.uuid);
      if (!partial?.renderedAny) return false;

      for (const [index, block] of (message.message?.content ?? []).entries()) {
        const activityId = `${message.uuid}:${index}`;
        if (block.type === "text") {
          applyActivity(tabId, {
            kind: "text_replace",
            id: activityId,
            text: block.text ?? "",
          });
        } else if (block.type === "thinking") {
          applyActivity(tabId, {
            kind: "thinking_replace",
            id: activityId,
            text: block.thinking ?? "",
          });
        } else if (block.type === "tool_use" && block.id) {
          applyActivity(tabId, {
            kind: "tool_started",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      if (message.message?.usage) {
        useAgentChatStore.getState()._appendMessage(tabId, {
          type: "system",
          subtype: "usage",
          usage: message.message.usage,
        });
      }
      tabMessages?.delete(message.uuid);
      return true;
    }

    function handleStreamMessage(payload: ProviderOutputPayload) {
      const { tab_id: tabId, data } = payload;

      let msg: any;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      const chatStore = useAgentChatStore.getState();

      // Only process messages if this tab is still streaming
      const tab = chatStore.tabs.find((t) => t.id === tabId);
      if (!tab?.isStreaming) return;
      if (
        !msg.session_id ||
        !tab.sessionId ||
        msg.session_id === tab.sessionId
      ) {
        chatStore._recordContextUsage(tabId, "claude", msg);
        const status = claudeProviderStatus(msg);
        if (status !== undefined)
          chatStore._setProviderStatus(tabId, "claude", status);
      }

      const count = (msgCountRef.current.get(tabId) ?? 0) + 1;
      msgCountRef.current.set(tabId, count);
      const now = performance.now();
      if (count === 1) streamStartTimeRef.current.set(tabId, now);
      const lastTime = lastMsgTimeRef.current.get(tabId);
      const gap = lastTime ? ((now - lastTime) / 1000).toFixed(1) : "0";
      lastMsgTimeRef.current.set(tabId, now);

      // Log ALL message types with gap detection
      const contentTypes =
        msg.message?.content?.map((b: any) => b.type).join(",") ?? "";
      const gapWarning = Number(gap) > 10 ? ` GAP ${gap}s` : "";
      log.debug(
        `[${tabId}] ${elapsed(tabId)} #${count} type=${msg.type} sub=${msg.subtype ?? ""} content=[${contentTypes}] gap=${gap}s${gapWarning}`,
      );

      if (tab?.compacting) {
        if (msg.type === "result" && msg.is_error)
          chatStore._setError(
            tabId,
            msg.errors?.join("\n") || msg.result || "Claude compaction failed.",
          );
        if (msg.type === "assistant" && msg.error)
          chatStore._setError(tabId, msg.error);
        return;
      }
      if (handleClaudePartialMessage(tabId, msg)) {
        return;
      }

      if (msg.type === "assistant") {
        const thinkingBlock = msg.message?.content?.find(
          (b: any) => b.type === "thinking",
        );
        if (thinkingBlock) {
          log.debug(
            `[${tabId}] ${elapsed(tabId)} thinking: ${(thinkingBlock.thinking || "").slice(0, 100)}`,
          );
        }
        const textBlock = msg.message?.content?.find(
          (b: any) => b.type === "text",
        );
        if (textBlock?.text) {
          log.debug(
            `[${tabId}] ${elapsed(tabId)} text: ${textBlock.text.slice(0, 100)}`,
          );
        }
        const toolBlock = msg.message?.content?.find(
          (b: any) => b.type === "tool_use",
        );
        if (toolBlock) {
          log.debug(
            `[${tabId}] ${elapsed(tabId)} tool_use: ${toolBlock.name} ${toolBlock.input?.file_path ?? ""}`,
          );
        }
      }
      if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result") {
            const preview =
              typeof block.content === "string"
                ? block.content.slice(0, 80)
                : JSON.stringify(block.content)?.slice(0, 80);
            log.debug(
              `[${tabId}] ${elapsed(tabId)} tool_result: id=${block.tool_use_id} err=${block.is_error ?? false} len=${preview?.length ?? 0}`,
            );
          }
        }
      }
      if (msg.type === "result") {
        log.info(
          `[${tabId}] ${elapsed(tabId)} result cost=$${msg.cost_usd} api=${msg.duration_api_ms}ms total=${msg.duration_ms}ms`,
        );
      }

      // Extract session_id from system:init
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        chatStore._setSessionId(tabId, msg.session_id);
      }

      // Quota status is telemetry, not a failed request. Preserve real failures
      // from SDK result/error events instead of interpreting these updates.
      if ((msg as any).type === "rate_limit_event") {
        log.debug(`[${tabId}] quota update`, (msg as any).rate_limit_info);
        return;
      }
      if (msg.type === "result" && msg.is_error) {
        chatStore._setError(
          tabId,
          msg.errors?.length
            ? msg.errors.join("\n")
            : msg.result ||
                useAgentChatStore
                  .getState()
                  .tabs.find((tab) => tab.id === tabId)?.error ||
                "Claude request failed.",
        );
      }
      if (msg.type === "assistant" && msg.error) {
        const detail = msg.message?.content
          ?.filter(
            (block: { type: string; text?: string }) => block.type === "text",
          )
          .map((block: { text?: string }) => block.text)
          .join("\n");
        chatStore._setError(tabId, detail || msg.error);
      }

      // Track tool_use blocks for file change detection
      const tabToolUses = pendingToolUsesRef.current.get(tabId) ?? new Map();
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use" && block.id && block.name) {
            tabToolUses.set(block.id, {
              name: block.name,
              input: block.input,
            });
          }
        }
        pendingToolUsesRef.current.set(tabId, tabToolUses);
      }

      // Skip duplicate user messages we already added locally
      if (
        msg.type === "user" &&
        msg.message?.content?.length === 1 &&
        msg.message.content[0].type === "text"
      ) {
        return;
      }

      if (!finalizeClaudePartialMessage(tabId, msg)) {
        chatStore._appendMessage(tabId, msg);
      }

      // When AskUserQuestion is detected, cancel the process so the user
      // can interact with the widget before the stream continues.
      if (msg.type === "assistant" && msg.message?.content) {
        const hasAskUser = msg.message.content.some(
          (b: any) => b.type === "tool_use" && b.name === "AskUserQuestion",
        );
        if (hasAskUser) {
          log.info(
            `[${tabId}] ${elapsed(tabId)} AskUserQuestion detected — cancelling process for user input`,
          );
          chatStore._setRoundWaiting(tabId, "legacy-question", true);
          cancelledForAskRef.current.set(tabId, true);
          invoke("cancel_claude_execution", { tabId }).catch(() => {});
        }
      }
    }

    async function handleClaudeComplete(payload: ProviderCompletePayload) {
      const { tab_id: tabId, success } = payload;
      const count = msgCountRef.current.get(tabId) ?? 0;

      log.info(
        `[${tabId}] complete success=${success} (${count} messages) cancelledForAsk=${cancelledForAskRef.current.get(tabId) ?? false}`,
      );
      await handlePostComplete(tabId, success, "claude");
    }

    function handleCodexStreamMessage(payload: ProviderOutputPayload) {
      const { tab_id: tabId, data } = payload;
      let msg: any;
      try {
        msg = JSON.parse(data);
      } catch {
        const text = data.trim();
        if (text) {
          const lines = codexPlainOutputRef.current.get(tabId) ?? [];
          lines.push(text);
          codexPlainOutputRef.current.set(tabId, lines);
        }
        return;
      }

      const chatStore = useAgentChatStore.getState();
      const tab = chatStore.tabs.find((t) => t.id === tabId);
      if (!tab?.isStreaming) return;

      const count = (msgCountRef.current.get(tabId) ?? 0) + 1;
      msgCountRef.current.set(tabId, count);
      const now = performance.now();
      if (count === 1) streamStartTimeRef.current.set(tabId, now);
      lastMsgTimeRef.current.set(tabId, now);

      log.debug(`[${tabId}] ${elapsed(tabId)} codex type=${msg.type ?? "?"}`);
      const status = readCodexProviderStatus(msg);
      if (!msg.params?.threadId || msg.params.threadId === tab.sessionId)
        chatStore._recordContextUsage(tabId, "codex", msg);
      if (status !== undefined) {
        chatStore._setProviderStatus(tabId, "codex", status);
        return;
      }

      const codexThreadId = getCodexThreadId(msg);
      if (
        codexThreadId &&
        (msg.type === "thread.started" ||
          msg.method === "thread/started" ||
          (msg.id === 2 && msg.result?.thread))
      ) {
        chatStore._setSessionId(tabId, codexThreadId);
      }

      if (msg.type === "error" && typeof msg.message === "string") {
        chatStore._setError(tabId, msg.message);
      }
    }

    function handlePiOutput(payload: ProviderOutputPayload) {
      const { tab_id: tabId, data } = payload;
      const store = useAgentChatStore.getState();
      const tab = store.tabs.find((item) => item.id === tabId);
      if (!tab?.isStreaming || tab.provider !== "pi") return;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data);
        if (!parsed || typeof parsed !== "object") return;
        message = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === "extension_error") {
        store._appendMessage(tabId, {
          type: "result",
          subtype: "error",
          result: `Pi extension error (${String(message.event ?? "unknown hook")}): ${String(message.error ?? "Unknown error")}\n${String(message.extensionPath ?? "")}`,
        });
        return;
      }
      if (
        [
          "compaction_start",
          "auto_retry_start",
          "summarization_retry_scheduled",
          "summarization_retry_attempt_start",
        ].includes(String(message.type))
      ) {
        store._setProviderStatus(
          tabId,
          "pi",
          message.type === "compaction_start" ||
            message.type === "summarization_retry_attempt_start"
            ? "compacting"
            : "retrying",
        );
        return;
      }
      if (
        [
          "compaction_end",
          "auto_retry_end",
          "summarization_retry_finished",
        ].includes(String(message.type))
      ) {
        store._setProviderStatus(tabId, "pi", null);
        const result = message.result as
          | { estimatedTokensAfter?: number }
          | undefined;
        if (
          message.type === "compaction_end" &&
          typeof result?.estimatedTokensAfter === "number"
        ) {
          store._recordContextUsage(tabId, "pi", {
            type: "usage",
            tokens: result.estimatedTokensAfter,
            capacity: tab.contextUsage?.pi?.capacity,
          });
        }
        const error = message.errorMessage ?? message.finalError;
        if (typeof error === "string" && message.aborted !== true) {
          store._appendMessage(tabId, {
            type: "result",
            subtype: "error",
            result: `Pi: ${error}`,
          });
        }
        return;
      }
      if (
        message.type === "session" &&
        typeof message.session_id === "string"
      ) {
        store._setSessionId(tabId, message.session_id);
      } else if (!message.session_id || message.session_id === tab.sessionId) {
        store._recordContextUsage(tabId, "pi", message);
      }
    }

    function handleProviderActivity(
      payload: ProviderActivityPayload,
      provider: ChatProvider,
    ) {
      const {
        tab_id: tabId,
        kind,
        item_id: itemId,
        text,
        name,
        input,
        content,
        is_error: isError,
      } = payload;
      const store = useAgentChatStore.getState();
      const tab = store.tabs.find((item) => item.id === tabId);
      if (
        !tab?.isStreaming ||
        tab.provider !== provider ||
        tab.compacting ||
        !itemId
      )
        return;

      const count = (msgCountRef.current.get(tabId) ?? 0) + 1;
      msgCountRef.current.set(tabId, count);
      store._applyActivity(tabId, {
        kind,
        id: itemId,
        text: text ?? undefined,
        name: name ?? undefined,
        input,
        content,
        isError: isError ?? undefined,
      });
    }

    async function handleCodexComplete(payload: ProviderCompletePayload) {
      const { tab_id: tabId, success } = payload;
      log.info(`[${tabId}] codex complete success=${success}`);
      appendCodexPlainImageOutput(tabId);
      await handlePostComplete(tabId, success, "codex");
    }

    function appendCodexPlainImageOutput(tabId: string) {
      const lines = codexPlainOutputRef.current.get(tabId) ?? [];
      const text = lines.join("\n").trim();
      if (!text) return;
      const imageUrls = extractImageFileUrls(text);
      if (imageUrls.length === 0) return;

      const store = useAgentChatStore.getState();
      const tab = store.tabs.find((t) => t.id === tabId);
      if (!tab?.isStreaming) return;
      const last = tab.messages[tab.messages.length - 1];
      if (imageUrls.some((url) => assistantMessageContainsFileUrl(last, url))) {
        return;
      }

      store._appendMessage(tabId, assistantMessageFromCodexText(text));
    }

    function handleCodexFinal(payload: CodexFinalPayload) {
      const { tab_id: tabId, data, item_id: itemId } = payload;
      const store = useAgentChatStore.getState();
      const tab = store.tabs.find((t) => t.id === tabId);
      if (!tab?.isStreaming || tab.compacting) return;
      const count = (msgCountRef.current.get(tabId) ?? 0) + 1;
      msgCountRef.current.set(tabId, count);
      const text = data.trim();
      if (!text) return;
      if (itemId && extractImageFileUrls(text).length === 0) {
        store._applyActivity(tabId, {
          kind: "text_replace",
          id: itemId,
          text,
        });
        return;
      }
      const last = tab.messages[tab.messages.length - 1];
      const lastText =
        last?.type === "assistant" &&
        last.message?.content?.length === 1 &&
        last.message.content[0].type === "text"
          ? (last.message.content[0].text?.trim() ?? "")
          : "";
      if (lastText && lastText === text) {
        return;
      }
      const imageUrls = extractImageFileUrls(text);
      if (imageUrls.some((url) => assistantMessageContainsFileUrl(last, url))) {
        return;
      }

      store._appendMessage(tabId, assistantMessageFromCodexText(text));
    }

    // Set up listeners once and keep them alive for the component lifetime.
    // Each listener is added to listenersRef immediately after registration
    // to avoid a race condition where unmount happens mid-setup.
    let cancelled = false;
    (async () => {
      const unlistenOutput = await listen<ProviderOutputPayload>(
        "claude-output",
        (event) => {
          if (!cancelled) handleStreamMessage(event.payload);
        },
      );
      if (cancelled) {
        unlistenOutput();
        return;
      }
      listenersRef.current.push(unlistenOutput);

      const unlistenComplete = await listen<ProviderCompletePayload>(
        "claude-complete",
        (event) => {
          if (!cancelled) handleClaudeComplete(event.payload);
        },
      );
      if (cancelled) {
        unlistenComplete();
        return;
      }
      listenersRef.current.push(unlistenComplete);

      for (const name of ["claude-error", "claude-diagnostic"] as const) {
        const unlisten = await listen<ProviderErrorPayload>(name, (event) => {
          if (cancelled) return;
          const { tab_id: tabId, data } = event.payload;
          if (name === "claude-diagnostic") {
            log.debug(`[${tabId}] stderr: ${data}`);
          } else {
            log.error(`[${tabId}] ${data}`);
            useAgentChatStore.getState()._setError(tabId, data);
          }
        });
        if (cancelled) {
          unlisten();
          return;
        }
        listenersRef.current.push(unlisten);
      }

      const unlistenCodexOutput = await listen<ProviderOutputPayload>(
        "codex-output",
        (event) => {
          if (!cancelled) handleCodexStreamMessage(event.payload);
        },
      );
      if (cancelled) {
        unlistenCodexOutput();
        return;
      }
      listenersRef.current.push(unlistenCodexOutput);

      const unlistenCodexActivity = await listen<ProviderActivityPayload>(
        "codex-activity",
        (event) => {
          if (!cancelled) handleProviderActivity(event.payload, "codex");
        },
      );
      if (cancelled) {
        unlistenCodexActivity();
        return;
      }
      listenersRef.current.push(unlistenCodexActivity);

      const unlistenCommentCheck = await listen<CommentSourceCheck>(
        "catalex-comment-check-source",
        (event) => {
          if (cancelled) return;
          void commentSourceMatches(event.payload)
            .catch(() => false)
            .then((matches) =>
              invoke("confirm_comment_source", {
                requestId: event.payload.requestId,
                matches,
              }),
            )
            .catch((error) =>
              log.warn("Comment source confirmation expired", { error }),
            );
        },
      );
      if (cancelled) {
        unlistenCommentCheck();
        return;
      }
      listenersRef.current.push(unlistenCommentCheck);

      let recoveringQuestions = true;
      const closedDuringRecovery = new Set<string>();
      const unlistenQuestion = await listen<AgentQuestion>(
        "catalex-question",
        (event) => {
          if (!cancelled)
            useAgentQuestionStore.getState().receive(event.payload);
        },
      );
      if (cancelled) {
        unlistenQuestion();
        return;
      }
      listenersRef.current.push(unlistenQuestion);
      const unlistenQuestionClosed = await listen<{ requestId: string }>(
        "catalex-question-closed",
        (event) => {
          if (recoveringQuestions)
            closedDuringRecovery.add(event.payload.requestId);
          if (!cancelled)
            useAgentQuestionStore.getState().remove(event.payload.requestId);
        },
      );
      if (cancelled) {
        unlistenQuestionClosed();
        return;
      }
      listenersRef.current.push(unlistenQuestionClosed);
      // Recover a still-pending question after a webview/hook remount.
      void invoke<AgentQuestion[]>("list_agent_questions")
        .then((questions) => {
          if (!cancelled && Array.isArray(questions))
            questions.forEach((question) => {
              if (!closedDuringRecovery.has(question.requestId))
                useAgentQuestionStore.getState().receive(question);
            });
        })
        .catch((error) =>
          log.warn("Could not recover pending agent questions", { error }),
        )
        .finally(() => {
          recoveringQuestions = false;
          closedDuringRecovery.clear();
        });

      const unlistenVerificationCompile =
        await listen<VerificationCompilePayload>(
          "catalex-verification-compile",
          (event) => {
            if (!cancelled) void handleVerificationCompile(event.payload);
          },
        );
      if (cancelled) {
        unlistenVerificationCompile();
        return;
      }
      listenersRef.current.push(unlistenVerificationCompile);

      const unlistenVerificationRenderPage =
        await listen<VerificationRenderPagePayload>(
          "catalex-verification-render-page",
          (event) => {
            if (!cancelled) void handleVerificationRenderPage(event.payload);
          },
        );
      if (cancelled) {
        unlistenVerificationRenderPage();
        return;
      }
      listenersRef.current.push(unlistenVerificationRenderPage);

      const unlistenCodexFinal = await listen<CodexFinalPayload>(
        "codex-final",
        (event) => {
          if (!cancelled) handleCodexFinal(event.payload);
        },
      );
      if (cancelled) {
        unlistenCodexFinal();
        return;
      }
      listenersRef.current.push(unlistenCodexFinal);

      const unlistenCodexComplete = await listen<ProviderCompletePayload>(
        "codex-complete",
        (event) => {
          if (!cancelled) handleCodexComplete(event.payload);
        },
      );
      if (cancelled) {
        unlistenCodexComplete();
        return;
      }
      listenersRef.current.push(unlistenCodexComplete);

      const unlistenCodexError = await listen<ProviderErrorPayload>(
        "codex-error",
        (event) => {
          if (!cancelled) {
            const { tab_id: tabId, data } = event.payload;
            log.warn(`[${tabId}] codex stderr: ${data}`);
            const plainLines = codexPlainOutputRef.current.get(tabId) ?? [];
            plainLines.push(data);
            codexPlainOutputRef.current.set(tabId, plainLines);
            const tabError = useAgentChatStore
              .getState()
              .tabs.find((t) => t.id === tabId)?.error;
            if (tabError) return;

            const lower = data.toLowerCase();
            const isCritical =
              lower.includes("fatal error") ||
              lower.includes("thread/start failed") ||
              lower.includes("failed to create session") ||
              lower.includes("permission denied") ||
              lower.includes("unexpected argument") ||
              lower.includes("unknown option") ||
              lower.includes("not authenticated") ||
              lower.includes("authentication failed");

            if (isCritical) {
              const cleaned = data.trim();
              const maxLen = 220;
              const detail =
                cleaned.length > maxLen
                  ? `${cleaned.slice(0, maxLen).trimEnd()}...`
                  : cleaned;
              useAgentChatStore
                .getState()
                ._setError(tabId, `Codex startup failed: ${detail}`);
            }
          }
        },
      );
      if (cancelled) {
        unlistenCodexError();
        return;
      }
      listenersRef.current.push(unlistenCodexError);

      const piListeners: Array<[string, (event: { payload: any }) => void]> = [
        ["pi-output", (event) => handlePiOutput(event.payload)],
        ["pi-activity", (event) => handleProviderActivity(event.payload, "pi")],
        [
          "pi-complete",
          (event) => {
            void handlePostComplete(
              event.payload.tab_id,
              event.payload.success,
              "pi",
            );
          },
        ],
        [
          "pi-error",
          (event) => {
            const { tab_id: tabId, data } =
              event.payload as ProviderErrorPayload;
            const store = useAgentChatStore.getState();
            const tab = store.tabs.find((item) => item.id === tabId);
            if (tab?.isStreaming && tab.provider === "pi") {
              store._setError(tabId, data);
            }
          },
        ],
      ];
      for (const [name, handler] of piListeners) {
        const unlisten = await listen(name, (event) => {
          if (!cancelled) handler(event);
        });
        if (cancelled) {
          unlisten();
          return;
        }
        listenersRef.current.push(unlisten);
      }
    })();

    return () => {
      cancelled = true;
      const store = useAgentChatStore.getState();
      for (const tab of store.tabs) {
        if (tab.providerStatus)
          store._setProviderStatus(tab.id, tab.provider, null);
      }
      for (const unlisten of listenersRef.current) {
        unlisten();
      }
      listenersRef.current = [];
    };
  }, []); // mount-only
}
