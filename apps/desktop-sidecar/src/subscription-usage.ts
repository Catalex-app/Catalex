import {
  query as startClaudeQuery,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export async function readClaudeSubscriptionUsage(
  claudeCliPath: string,
  cwd: string,
  startQuery = startClaudeQuery,
): Promise<SDKControlGetUsageResponse> {
  let finishInput!: () => void;
  const inputClosed = new Promise<void>((resolve) => {
    finishInput = resolve;
  });
  async function* emptyInput(): AsyncGenerator<SDKUserMessage> {
    await inputClosed;
    yield* [];
  }
  const query = startQuery({
    prompt: emptyInput(),
    options: {
      pathToClaudeCodeExecutable: claudeCliPath,
      cwd,
      persistSession: false,
      settingSources: ["user"],
      settings: { disableAllHooks: true },
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const readUsage =
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof readUsage !== "function") {
      throw new Error(
        "This Claude version does not support subscription usage.",
      );
    }
    return await Promise.race([
      readUsage.call(query),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("Claude subscription usage timed out. Please retry."),
            ),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    finishInput();
    query.close();
  }
}
