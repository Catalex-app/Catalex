import type { McpHttpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export interface CatalexMcpConnection {
  url: string;
  headers: Record<string, string>;
}

// The app owns discovery, schemas and execution. This is only client configuration.
export function catalexMcpConfig(
  connection: CatalexMcpConnection,
): McpHttpServerConfig {
  return {
    type: "http",
    url: connection.url,
    headers: connection.headers,
    // Leave time for the app's bounded 10-minute user-question wait.
    timeout: 660_000,
    alwaysLoad: true,
  };
}
