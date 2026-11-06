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
test("all app tools and web tools are preauthorized", () => {
  for (const tool of [
    "compile",
    "diagnostics",
    "workspace_state",
    "render_page",
    "read_pdf",
    "ask_user",
    "create_comment",
    "list_comments",
    "edit_comment",
    "resolve_comment",
    "delete_comment",
  ])
    expect(allowedClaudeTools).toContain(`mcp__catalex__${tool}`);
  expect(allowedClaudeTools).toContain("WebFetch");
  expect(allowedClaudeTools).toContain("WebSearch");
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
