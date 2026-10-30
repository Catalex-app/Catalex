import {
  query as startClaudeQuery,
  type ModelInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** Initialize the CLI without submitting a user turn or creating a session. */
export async function discoverClaudeModels(
  claudeCliPath: string,
  cwd: string,
  startQuery = startClaudeQuery,
): Promise<ModelInfo[]> {
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
      settingSources: ["user", "project", "local"],
      settings: { disableAllHooks: true },
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      query.supportedModels(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("Claude model discovery timed out. Please retry."),
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

/** Probe the requested model with one tool-free, ephemeral turn. */
export async function verifyClaudeModel(
  claudeCliPath: string,
  cwd: string,
  modelId: string,
  startQuery = startClaudeQuery,
): Promise<{ id: string; displayName?: string }> {
  const query = startQuery({
    prompt: "Reply with OK only.",
    options: {
      pathToClaudeCodeExecutable: claudeCliPath,
      cwd,
      model: modelId,
      persistSession: false,
      settingSources: ["user"],
      settings: { disableAllHooks: true },
      systemPrompt: "This is a model availability check. Reply with OK only.",
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 1,
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const models = await query.supportedModels();
        const metadata = models.find((model) => model.value === modelId);
        for await (const message of query) {
          if (
            message.type === "system" &&
            message.subtype === "model_refusal_fallback"
          ) {
            throw new Error(
              "The provider switched to another model. This ID could not be verified.",
            );
          }
          if (message.type !== "result") continue;
          if (message.subtype !== "success" || message.is_error) {
            throw new Error(
              message.subtype === "success"
                ? message.result
                : message.errors.join("\n"),
            );
          }
          return { id: modelId, displayName: metadata?.displayName };
        }
        throw new Error("Claude ended without verifying this model.");
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error("Model verification timed out. Please retry.")),
          45_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    query.close();
  }
}
