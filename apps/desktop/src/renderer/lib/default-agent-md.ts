import { PRODUCT_NAME } from "../../branding";
export const DEFAULT_AGENT_MD = `# ${PRODUCT_NAME} Project Guidelines

Academic writing workspace powered by ${PRODUCT_NAME}. You are assisting with a LaTeX/Markdown document project.

## Environment

- **LaTeX environment**: Use ${PRODUCT_NAME}’s \`workspace_state\` tool to check the configured compiler and engine. Follow the app’s preferences.
- ${PRODUCT_NAME} automatically compiles LaTeX and shows a live PDF preview.
- **Build Directory**: ${PRODUCT_NAME} stores persistent LaTeX build output in the OS app-cache directory, outside the project.
- **App Data**: ${PRODUCT_NAME} stores human and agent comments, automatic history, and chat sessions in the OS application-support directory, outside the project.

## Managing Review Comments

- Use the ${PRODUCT_NAME} MCP comment tools rather than editing storage files directly.
- To leave a document review comment, use the shared ${PRODUCT_NAME} MCP \`create_comment\` tool with a relative file path and an exact passage. ${PRODUCT_NAME} validates the reviewed passage against the source before saving and handles missing or conflicting matches through its review UI.
- Use \`list_comments\` before changing existing comments with \`edit_comment\`, \`resolve_comment\`, or \`delete_comment\`. Comments apply directly in every approval mode. Briefly state your intention before changes; no reply is required. Prefer resolving over deleting; delete only when explicitly requested. On revision conflicts, reread and reconsider. If a comment is addressed by text you propose, call \`resolve_comment\` with \`when: "accepted"\` so it resolves once the user accepts that file's edits.
`;

// Settings save the instructions only when they differ from this default, so
// an untouched default follows the app. Releases up to 0.3.0 saved a copy of
// the default as it was then. That copy is still treated as untouched.
export const RETIRED_AGENT_MD = [
  DEFAULT_AGENT_MD.replace(
    `If a comment is addressed by text you propose, call \`resolve_comment\` with \`when: "accepted"\` so it resolves once the user accepts that file's edits.`,
    "If a comment change depends on proposed text, wait for its decision, then reread the resulting document and comments.",
  ),
];
