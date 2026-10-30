import { expect, test } from "@playwright/test";

test("Claude permissions show the action and explicit approval scopes", async ({
  page,
}) => {
  await page.goto("/?debug=agent-pause&provider=claude");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const load = async (name: string) => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find(
          (entry) =>
            new URL(entry).pathname === `/src/renderer/stores/${name}.ts`,
        );
      if (!url) throw new Error(`Missing module ${name}`);
      return import(url);
    };
    const { useAgentChatStore } = await load("agent-chat-store");
    const { useAgentQuestionStore } = await load("agent-question-store");
    const state = useAgentChatStore.getState();
    const tab = state.tabs.find((item: any) => item.id === state.activeTabId);
    useAgentQuestionStore.getState().receive({
      requestId: "permission-demo",
      permission: true,
      tabId: tab.id,
      sessionId: tab.runtimeSessionKey,
      projectRoot: "/pause-project",
      question: "Allow Claude to use this tool?",
      details: 'Tool: ExampleTool\n\n{"path":"main.tex"}',
      options: [
        { label: "Deny", description: "Do not run this action." },
        { label: "Approve once", description: "Only this call." },
        {
          label: "Approve suggested rule",
          description: "Apply Claude's suggested permissions to this session.",
        },
      ],
    });
  });
  const question = page.getByRole("region", { name: "Agent question" });
  await expect(question).toBeVisible();
  await question.getByText("Action details", { exact: true }).click();
  await expect(question.locator("pre")).toContainText('"path":"main.tex"');
  for (const name of ["Deny", "Approve once", "Approve suggested rule"])
    await expect(
      question.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  await expect(
    question.getByRole("button", { name: "Skip", exact: true }),
  ).toHaveCount(0);
  await expect(
    question.getByPlaceholder("Or type your own answer"),
  ).toHaveCount(0);
  await page.screenshot({ path: "/tmp/claude-permission-prompt.png" });
});
