import { expect, test } from "bun:test";
import {
  createPermissionHandler,
  allowedClaudeTools,
} from "./tool-permissions.js";

const options = () => ({
  signal: new AbortController().signal,
  toolUseID: "tool",
  requestId: "request",
});
test("the app's tools and web tools are preauthorized", () => {
  expect(allowedClaudeTools(["compile", "ask_user"])).toEqual([
    "WebFetch",
    "WebSearch",
    "mcp__catalex__compile",
    "mcp__catalex__ask_user",
  ]);
});
test("deny, skip, custom answers, cancellation, and unavailable UI never authorize", async () => {
  for (const answer of [
    "Deny",
    "Skip this question (no option selected).",
    "yes",
    "",
  ]) {
    const handler = createPermissionHandler({
      ask: async () => answer,
    });
    expect((await handler("Other", {}, options()))?.behavior).toBe("deny");
  }
  const controller = new AbortController();
  const handler = createPermissionHandler({
    ask: async () => {
      controller.abort();
      return "Approve once";
    },
  });
  expect(
    (await handler("Other", {}, { ...options(), signal: controller.signal }))
      ?.behavior,
  ).toBe("deny");
});
test("once never caches approval and offers no invented rules", async () => {
  let calls = 0;
  const handler = createPermissionHandler({
    ask: async (question) => {
      calls++;
      expect(question.options.map((item) => item.label)).toEqual([
        "Deny",
        "Approve once",
      ]);
      return "Approve once";
    },
  });
  for (let i = 0; i < 2; i++)
    expect(await handler("Other", {}, options())).toEqual({
      behavior: "allow",
      updatedInput: {},
    });
  expect(calls).toBe(2);
});
test("suggested permissions are returned unchanged to the SDK", async () => {
  for (const destination of [
    "session",
    "userSettings",
    "projectSettings",
    "localSettings",
    "cliArg",
  ] as const) {
    const suggestions = [
      {
        type: "addRules" as const,
        rules: [{ toolName: "Other", ruleContent: "example" }],
        behavior: "allow" as const,
        destination,
      },
    ];
    const handler = createPermissionHandler({
      ask: async (question) => {
        expect(question.details).toContain(
          JSON.stringify(suggestions, null, 2),
        );
        expect(question.options).toHaveLength(3);
        return "Approve suggested rule";
      },
    });
    expect(await handler("Other", {}, { ...options(), suggestions })).toEqual({
      behavior: "allow",
      updatedInput: {},
      updatedPermissions: suggestions,
    });
  }
});

test("an unavailable permission UI denies and does not poison subsequent requests", async () => {
  let calls = 0;
  const handler = createPermissionHandler({
    ask: async () => {
      if (++calls === 1) throw new Error("closed");
      return "Approve once";
    },
  });
  expect((await handler("Other", {}, options()))?.behavior).toBe("deny");
  expect((await handler("Other", {}, options()))?.behavior).toBe("allow");
});
