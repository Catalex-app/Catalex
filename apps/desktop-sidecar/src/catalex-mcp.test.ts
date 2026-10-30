import { expect, test } from "bun:test";
import { catalexMcpConfig } from "./catalex-mcp.js";

test("Claude connects to the app-owned HTTP MCP without defining tools", () => {
  const connection = {
    url: "http://127.0.0.1:1234/mcp",
    headers: { Authorization: "Bearer test-scope" },
  };
  expect(catalexMcpConfig(connection)).toEqual({
    ...connection,
    type: "http",
    timeout: 660_000,
    alwaysLoad: true,
  });
});
