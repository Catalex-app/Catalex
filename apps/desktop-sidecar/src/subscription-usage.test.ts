import { expect, mock, test } from "bun:test";
import type {
  query,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readClaudeSubscriptionUsage } from "./subscription-usage.js";

test("subscription usage sends no user turn and disables session side effects", async () => {
  const usage = {
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 25, resets_at: null } },
  };
  const close = mock(() => {});
  let input!: Promise<IteratorResult<SDKUserMessage>>;
  const readUsage = mock(async () => usage);
  const start = mock((args: Parameters<typeof query>[0]) => {
    expect(args.options).toEqual({
      pathToClaudeCodeExecutable: "/claude",
      cwd: "/isolated",
      persistSession: false,
      settingSources: ["user"],
      settings: { disableAllHooks: true },
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
    });
    input = (args.prompt as AsyncIterable<SDKUserMessage>)
      [Symbol.asyncIterator]()
      .next();
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: readUsage,
      close,
    } as unknown as Query;
  });
  expect(await readClaudeSubscriptionUsage("/claude", "/isolated", start)).toBe(
    usage,
  );
  expect(await input).toEqual({ done: true, value: undefined });
  expect(readUsage).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

test("subscription usage closes cleanly for unsupported SDKs and failed requests", async () => {
  for (const supported of [false, true]) {
    const close = mock(() => {});
    let input!: Promise<IteratorResult<SDKUserMessage>>;
    const start = ((args: Parameters<typeof query>[0]) => {
      input = (args.prompt as AsyncIterable<SDKUserMessage>)
        [Symbol.asyncIterator]()
        .next();
      return {
        close,
        ...(supported
          ? {
              usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:
                async () => {
                  throw new Error("Unsupported control request");
                },
            }
          : {}),
      };
    }) as unknown as typeof query;
    await expect(
      readClaudeSubscriptionUsage("/claude", "/isolated", start),
    ).rejects.toThrow(
      supported ? "Unsupported control request" : "does not support",
    );
    expect(await input).toEqual({ done: true, value: undefined });
    expect(close).toHaveBeenCalledTimes(1);
  }
});
