import { APP_NAMESPACE } from "./branding.js";
import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CatalexMcpConnection } from "./catalex-mcp.js";

export const allowedClaudeTools = [
  "WebFetch",
  "WebSearch",
  ...[
    "compile",
    "diagnostics",
    "workspace_state",
    "render_page",
    "ask_user",
    "create_comment",
    "list_comments",
    "edit_comment",
    "resolve_comment",
    "delete_comment",
  ].map((name) => `mcp__${APP_NAMESPACE}__${name}`),
];

const deny = (message: string): PermissionResult => ({
  behavior: "deny",
  message,
});

export type PermissionQuestion = {
  permission: true;
  question: string;
  details: string;
  options: { label: string; description: string }[];
};
export type AskPermission = (
  question: PermissionQuestion,
  signal: AbortSignal,
) => Promise<string>;

export function mcpPermissionQuestion(
  connection: CatalexMcpConnection,
): AskPermission {
  return async (question, signal) => {
    const client = new Client({
      name: `${APP_NAMESPACE}-permissions`,
      version: "1",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(connection.url),
      {
        requestInit: { headers: connection.headers },
      },
    );
    const abort = () => {
      void client.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.connect(transport);
      signal.throwIfAborted();
      const response = await client.callTool(
        { name: "ask_user", arguments: question },
        undefined,
        { signal, timeout: 600_000 },
      );
      if (response.isError)
        throw new Error("Permission question could not be answered.");
      const content = response.content as { type: string; text?: string }[];
      const result = JSON.parse(
        content.find((item) => item.type === "text")?.text ?? "{}",
      );
      if (result.status !== "answered" || typeof result.answer !== "string")
        throw new Error("No permission decision received.");
      return result.answer;
    } finally {
      signal.removeEventListener("abort", abort);
      await client.close();
    }
  };
}

export function createPermissionHandler({
  ask,
}: {
  ask: AskPermission;
}): CanUseTool {
  // The shared question UI permits one pending request per chat.
  let queue = Promise.resolve();
  return (toolName, input, options) => {
    const run = async (): Promise<PermissionResult> => {
      const { signal, suggestions } = options;
      try {
        signal.throwIfAborted();
        const scope = {
          session: "this session",
          userSettings: "your user settings",
          projectSettings: "shared project settings",
          localSettings: "local project settings",
          cliArg: "this invocation",
        };
        const choices = [
          { label: "Deny", description: "Do not run this action." },
          { label: "Approve once", description: "Allow only this tool call." },
        ];
        if (suggestions?.length) {
          choices.push({
            label: "Approve suggested rule",
            description: `Apply Claude's suggested permissions to ${[...new Set(suggestions.map((item) => scope[item.destination]))].join(", ")}.`,
          });
        }
        const answer = await ask(
          {
            permission: true,
            question: (
              options.title || `Allow Claude to use ${toolName}?`
            ).slice(0, 2000),
            details: [
              options.description,
              options.decisionReason,
              options.blockedPath ? `Path: ${options.blockedPath}` : "",
              `Tool: ${toolName}`,
              JSON.stringify(input, null, 2),
              suggestions?.length
                ? `Suggested permissions:\n${JSON.stringify(suggestions, null, 2)}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            options: choices,
          },
          signal,
        );
        signal.throwIfAborted();
        if (answer === "Approve once")
          return { behavior: "allow", updatedInput: input };
        if (answer === "Approve suggested rule" && suggestions?.length)
          return {
            behavior: "allow",
            updatedInput: input,
            updatedPermissions: suggestions,
          };
        return deny("The user did not approve this action.");
      } catch {
        return deny(
          "Permission was not granted: the request was cancelled, expired, or unavailable.",
        );
      }
    };
    const result = queue.then(run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
