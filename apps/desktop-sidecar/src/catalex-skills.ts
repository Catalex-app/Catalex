import { APP_NAMESPACE } from "./branding.js";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";

export const reviewSkillName = `${APP_NAMESPACE}:review-document`;

export function catalexSkillPlugin(root: string): SdkPluginConfig {
  // Skills only: the app already supplies the universal MCP connection.
  return { type: "local", path: root, skipMcpDiscovery: true };
}
