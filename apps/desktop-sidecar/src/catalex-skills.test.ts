import { expect, test } from "bun:test";
import { catalexSkillPlugin } from "./catalex-skills.js";

test("Claude loads bundled skills without a second MCP configuration", () => {
  const root = "/Applications/Catalex.app/Contents/Resources/catalex";
  expect(catalexSkillPlugin(root)).toEqual({
    type: "local",
    path: root,
    skipMcpDiscovery: true,
  });
});
