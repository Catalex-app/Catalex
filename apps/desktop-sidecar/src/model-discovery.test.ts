import { expect, mock, test } from "bun:test";
import type {
  query,
  Query,
  SDKUserMessage,
  ModelInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { discoverClaudeModels, verifyClaudeModel } from "./model-discovery.js";

test("discovery initializes the SDK without sending any user prompt and closes it", async () => {
  const models: ModelInfo[] = [
    {
      value: "claude-fable-5[1m]",
      displayName: "Fable",
      description: "Fable 5",
    },
  ];
  const close = mock(() => {});
  let input!: Promise<IteratorResult<SDKUserMessage>>;
  const start = mock((args: Parameters<typeof query>[0]) => {
    expect(args.options).toMatchObject({
      cwd: "/isolated",
      settingSources: ["user"],
      mcpServers: {},
      persistSession: false,
      tools: [],
      strictMcpConfig: true,
      settings: { disableAllHooks: true },
    });
    input = (args.prompt as AsyncIterable<SDKUserMessage>)
      [Symbol.asyncIterator]()
      .next();
    return { supportedModels: async () => models, close } as unknown as Query;
  });
  expect(await discoverClaudeModels("/claude", "/isolated", start)).toEqual(
    models,
  );
  expect(await input).toEqual({ value: undefined, done: true });
  expect(close).toHaveBeenCalledTimes(1);
});

test("discovery closes the SDK when initialization fails", async () => {
  const close = mock(() => {});
  const start = (() => ({
    supportedModels: async () => {
      throw new Error("Unavailable");
    },
    close,
  })) as unknown as typeof query;
  await expect(
    discoverClaudeModels("/claude", "/isolated", start),
  ).rejects.toThrow("Unavailable");
  expect(close).toHaveBeenCalledTimes(1);
});

test("verification probes a legacy model missing from discovery without tools or session persistence", async () => {
  const close = mock(() => {});
  const start = mock((args: Parameters<typeof query>[0]) => {
    expect(args.options).toMatchObject({
      model: "claude-legacy",
      persistSession: false,
      maxTurns: 1,
      settingSources: ["user"],
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settings: { disableAllHooks: true },
    });
    return {
      supportedModels: async () => [],
      close,
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "OK",
        };
      },
    } as unknown as Query;
  });
  expect(
    await verifyClaudeModel("/claude", "/isolated", "claude-legacy", start),
  ).toEqual({ id: "claude-legacy" });
  expect(close).toHaveBeenCalledTimes(1);
});

test("verification returns catalogue display names and rejects provider failures and fallback", async () => {
  for (const outcome of ["success", "error", "fallback", "empty"]) {
    const close = mock(() => {});
    const start = (() => ({
      supportedModels: async () => [
        { value: "legacy", displayName: "Legacy Model" },
      ],
      close,
      async *[Symbol.asyncIterator]() {
        if (outcome === "fallback")
          yield { type: "system", subtype: "model_refusal_fallback" };
        if (outcome !== "empty")
          yield {
            type: "result",
            subtype: "success",
            is_error: outcome === "error",
            result: "Unavailable model",
          };
      },
    })) as unknown as typeof query;
    const result = verifyClaudeModel("/claude", "/isolated", "legacy", start);
    if (outcome === "success")
      expect(await result).toEqual({
        id: "legacy",
        displayName: "Legacy Model",
      });
    else await expect(result).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  }
});
