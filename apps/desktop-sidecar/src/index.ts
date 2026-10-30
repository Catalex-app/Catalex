import { PRODUCT_NAME } from "./branding.js";
import { APP_NAMESPACE } from "./branding.js";
import {
  allowedClaudeTools,
  createPermissionHandler,
  mcpPermissionQuestion,
} from "./tool-permissions.js";
import { interruptAndWait } from "./interrupt-turn.js";
import {
  query as startClaudeQuery,
  type EffortLevel,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { catalexMcpConfig, type CatalexMcpConnection } from "./catalex-mcp.js";
import { reviewSkillName, catalexSkillPlugin } from "./catalex-skills.js";
import { discoverClaudeModels, verifyClaudeModel } from "./model-discovery.js";
import { readClaudeSubscriptionUsage } from "./subscription-usage.js";

// The host uses Electron's executable as Node for this bridge only. Never pass
// this launch flag to Claude or tools that may themselves open Electron apps.
delete process.env.ELECTRON_RUN_AS_NODE;

interface StartTurnCommand {
  type: "start_turn";
  requestId: string;
  conversationKey: string;
  prompt: string;
  cwd: string;
  sourceRoot: string;
  pluginRoot: string;
  claudeCliPath: string;
  clientVersion: string;
  mcp: CatalexMcpConnection;
  model?: string;
  effort?: EffortLevel;
  systemPrompt: string;
  resumeSessionId?: string;
  continueSession?: boolean;
}

interface CancelTurnCommand {
  type: "cancel_turn";
  requestId?: string;
}

interface DisposeCommand {
  type: "dispose";
}

type SidecarCommand = StartTurnCommand | CancelTurnCommand | DisposeCommand;

interface QueryConfiguration {
  mcpUrl: string;
  conversationKey: string;
  cwd: string;
  sourceRoot: string;
  pluginRoot: string;
  claudeCliPath: string;
  systemPrompt: string;
  model?: string;
  effort?: EffortLevel;
  resumeSessionId?: string;
  continueSession?: boolean;
}

class MessageChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: ((value: IteratorResult<SDKUserMessage>) => void) | null =
    null;
  private closed = false;
  private sessionId = "";

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  enqueue(prompt: string): void {
    if (this.closed) throw new Error("Claude message channel is closed");
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid: randomUUID(),
    };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

let activeQuery: Query | null = null;
let activeChannel: MessageChannel | null = null;
let activeAbortController: AbortController | null = null;
let activeConfiguration: QueryConfiguration | null = null;
let activeRequestId: string | null = null;
let activeTurn = false;
let consumerTask: Promise<void> | null = null;
let activeTurnCompletion: Promise<void> = Promise.resolve();
let resolveActiveTurn: (() => void) | null = null;

function finishActiveTurn(): void {
  resolveActiveTurn?.();
  resolveActiveTurn = null;
}

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DIRECT_FILE_WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

function directWriteTarget(toolName: string, input: unknown): string | null {
  if (
    !DIRECT_FILE_WRITE_TOOLS.has(toolName) ||
    !input ||
    typeof input !== "object"
  ) {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
}

function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = resolve(workspaceRoot);
  const absoluteTarget = isAbsolute(target)
    ? resolve(target)
    : resolve(root, target);
  const relativeTarget = relative(root, absoluteTarget);
  if (
    relativeTarget !== "" &&
    (relativeTarget === ".." ||
      relativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(relativeTarget))
  ) {
    return false;
  }

  // Reject symlink traversal even when the lexical path remains under the
  // candidate root. Direct file tools run in the host process and must not be
  // able to follow an agent-created link back into the source project.
  let cursor = root;
  for (const component of relativeTarget.split(/[\\/]/).filter(Boolean)) {
    cursor = resolve(cursor, component);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return false;
    } catch {
      break;
    }
  }

  const canonicalRoot = realpathSync(root);
  const canonicalTarget = resolve(canonicalRoot, relativeTarget);
  const canonicalRelative = relative(canonicalRoot, canonicalTarget);
  return (
    canonicalRelative === "" ||
    (canonicalRelative !== ".." &&
      !canonicalRelative.startsWith(`..${sep}`) &&
      !isAbsolute(canonicalRelative))
  );
}

function restartRequired(
  current: QueryConfiguration | null,
  next: QueryConfiguration,
): boolean {
  if (!current) return true;
  // resume/continue only select the session when the query is created. Once a
  // conversation is live, the MessageChannel must stay attached to that query.
  return (
    current.mcpUrl !== next.mcpUrl ||
    current.conversationKey !== next.conversationKey ||
    current.cwd !== next.cwd ||
    current.sourceRoot !== next.sourceRoot ||
    current.pluginRoot !== next.pluginRoot ||
    current.claudeCliPath !== next.claudeCliPath ||
    current.systemPrompt !== next.systemPrompt
  );
}

async function closeQuery(): Promise<void> {
  finishActiveTurn();
  const query = activeQuery;
  activeQuery = null;
  activeChannel?.close();
  activeChannel = null;
  activeAbortController?.abort();
  activeAbortController = null;
  activeConfiguration = null;
  activeTurn = false;
  activeRequestId = null;

  if (query) {
    query.close();
  }
  await consumerTask?.catch(() => undefined);
  consumerTask = null;
}

function buildOptions(command: StartTurnCommand): Options {
  return {
    cwd: command.cwd,
    pathToClaudeCodeExecutable: command.claudeCliPath,
    model: command.model,
    effort: command.effort,
    thinking: { type: "adaptive" },
    permissionMode: "auto",
    allowedTools: allowedClaudeTools,
    canUseTool: createPermissionHandler({
      ask: mcpPermissionQuestion(command.mcp),
    }),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ["*"] },
      filesystem: {
        allowWrite: [command.cwd],
        denyWrite: [command.sourceRoot],
      },
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name !== "PreToolUse") return {};
              const target = directWriteTarget(
                input.tool_name,
                input.tool_input,
              );
              if (!target || isInsideWorkspace(command.cwd, target)) return {};
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason:
                    PRODUCT_NAME +
                    " agents may write only inside the isolated draft workspace.",
                },
              };
            },
          ],
        },
      ],
    },
    includePartialMessages: true,
    enableFileCheckpointing: true,
    persistSession: true,
    settingSources: ["user", "project", "local"],
    plugins: [catalexSkillPlugin(command.pluginRoot)],
    mcpServers: {
      [APP_NAMESPACE]: catalexMcpConfig(command.mcp),
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: command.systemPrompt,
    },
    resume: command.resumeSessionId,
    continue: command.continueSession,
    abortController: activeAbortController ?? undefined,
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: `catalex-desktop/${command.clientVersion}`,
    },
  };
}

async function consume(query: Query): Promise<void> {
  try {
    for await (const message of query) {
      if (query !== activeQuery) return;
      if (
        message.type === "system" &&
        message.subtype === "init" &&
        !message.skills.includes(reviewSkillName)
      ) {
        throw new Error(
          `Claude did not discover ${PRODUCT_NAME}'s built-in ${reviewSkillName} skill.`,
        );
      }
      send({ type: "sdk_message", message });
      if (
        message.type === "system" &&
        message.subtype === "init" &&
        message.session_id
      ) {
        activeChannel?.setSessionId(message.session_id);
      }
      if (message.type === "result" && activeTurn) {
        const requestId = activeRequestId;
        activeTurn = false;
        activeRequestId = null;
        finishActiveTurn();
        send({
          type: "turn_complete",
          requestId,
          success: !message.is_error,
          subtype: message.subtype,
        });
      }
    }
    if (query === activeQuery) {
      const wasActive = activeTurn;
      const requestId = activeRequestId;
      activeQuery = null;
      activeChannel?.close();
      activeChannel = null;
      activeAbortController?.abort();
      activeAbortController = null;
      activeConfiguration = null;
      activeTurn = false;
      activeRequestId = null;
      finishActiveTurn();

      if (wasActive) {
        send({
          type: "turn_error",
          requestId,
          message: "Claude Agent SDK session ended unexpectedly",
        });
        send({ type: "turn_complete", requestId, success: false });
      }
    }
  } catch (error) {
    if (query !== activeQuery) return;
    const requestId = activeRequestId;
    activeQuery = null;
    activeChannel?.close();
    activeChannel = null;
    activeAbortController?.abort();
    activeAbortController = null;
    activeConfiguration = null;
    activeTurn = false;
    activeRequestId = null;
    finishActiveTurn();

    send({ type: "turn_error", requestId, message: errorText(error) });
    send({ type: "turn_complete", requestId, success: false });
  }
}

async function ensureQuery(command: StartTurnCommand): Promise<void> {
  const configuration: QueryConfiguration = {
    mcpUrl: command.mcp.url,
    conversationKey: command.conversationKey,
    cwd: command.cwd,
    sourceRoot: command.sourceRoot,
    pluginRoot: command.pluginRoot,
    claudeCliPath: command.claudeCliPath,
    systemPrompt: command.systemPrompt,
    model: command.model,
    effort: command.effort,
    resumeSessionId: command.resumeSessionId,
    continueSession: command.continueSession,
  };

  if (activeQuery && restartRequired(activeConfiguration, configuration)) {
    await closeQuery();
  }

  if (!activeQuery) {
    activeAbortController = new AbortController();
    activeChannel = new MessageChannel();
    if (command.resumeSessionId) {
      activeChannel.setSessionId(command.resumeSessionId);
    }
    const query = startClaudeQuery({
      prompt: activeChannel,
      options: buildOptions(command),
    });
    activeQuery = query;
    activeConfiguration = configuration;
    consumerTask = consume(query);
    return;
  }

  if (!activeConfiguration) return;
  if (activeConfiguration.model !== command.model) {
    await activeQuery.setModel(command.model);
  }
  if (activeConfiguration.effort !== command.effort) {
    await activeQuery.applyFlagSettings({
      effortLevel: command.effort ?? null,
    });
  }
  activeConfiguration = configuration;
}

async function startTurn(command: StartTurnCommand): Promise<void> {
  if (activeTurn) {
    send({
      type: "turn_error",
      requestId: command.requestId,
      message: "A Claude turn is already running",
    });
    send({
      type: "turn_complete",
      requestId: command.requestId,
      success: false,
    });
    return;
  }

  try {
    await ensureQuery(command);
    if (!activeChannel) throw new Error("Claude message channel unavailable");
    activeTurn = true;
    activeRequestId = command.requestId;
    activeTurnCompletion = new Promise<void>((resolve) => {
      resolveActiveTurn = resolve;
    });
    activeChannel.enqueue(command.prompt);
  } catch (error) {
    await closeQuery();
    activeTurn = false;
    activeRequestId = null;
    send({
      type: "turn_error",
      requestId: command.requestId,
      message: errorText(error),
    });
    send({
      type: "turn_complete",
      requestId: command.requestId,
      success: false,
    });
  }
}

async function cancelTurn(command: CancelTurnCommand): Promise<void> {
  const requestId = activeRequestId ?? command.requestId ?? null;
  if (!activeQuery || !activeTurn) return;
  try {
    const query = activeQuery;
    await interruptAndWait(() => query.interrupt(), activeTurnCompletion);
  } catch {
    // Never reuse a query whose interruption failed or did not finish. Closing
    // it suppresses late results; the next turn resumes the saved session.
    const needsCompletion = activeRequestId === requestId;
    await closeQuery();
    if (needsCompletion) {
      send({
        type: "turn_complete",
        requestId,
        success: false,
        cancelled: true,
      });
    }
  }
}

async function handleCommand(command: SidecarCommand): Promise<void> {
  if (command.type === "start_turn") {
    await startTurn(command);
    return;
  }
  if (command.type === "cancel_turn") {
    await cancelTurn(command);
    return;
  }
  await closeQuery();
  process.exit(0);
}

if (process.argv[2] === "--subscription-usage") {
  try {
    const claudeCliPath = process.argv[3];
    if (!claudeCliPath) throw new Error("Claude CLI path is required");
    send(
      await readClaudeSubscriptionUsage(
        claudeCliPath,
        process.argv[4] ?? process.cwd(),
      ),
    );
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[2] === "--list-models") {
  try {
    const claudeCliPath = process.argv[3];
    if (!claudeCliPath) throw new Error("Claude CLI path is required");
    const models = await discoverClaudeModels(
      claudeCliPath,
      process.argv[4] ?? process.cwd(),
    );
    send(models);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[2] === "--verify-model") {
  try {
    const [, , , cliPath, cwd, modelId] = process.argv;
    if (!cliPath || !cwd || !modelId)
      throw new Error("Model verification arguments are required");
    send(await verifyClaudeModel(cliPath, cwd, modelId));
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`);
    process.exit(1);
  }
}

send({ type: "ready", protocolVersion: 1 });

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
let commandQueue = Promise.resolve();

lines.on("line", (line) => {
  commandQueue = commandQueue.then(async () => {
    try {
      const command = JSON.parse(line) as SidecarCommand;
      await handleCommand(command);
    } catch (error) {
      send({ type: "protocol_error", message: errorText(error) });
    }
  });
});

lines.on("close", () => {
  void closeQuery().finally(() => process.exit(0));
});
