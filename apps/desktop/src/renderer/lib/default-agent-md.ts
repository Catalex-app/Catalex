import { PRODUCT_NAME } from "../../branding";
export const DEFAULT_AGENT_MD = `# ${PRODUCT_NAME} Project Guidelines

Academic writing workspace powered by ${PRODUCT_NAME}. You are assisting with a LaTeX/Markdown document project.

## Environment

- **LaTeX environment**: Use ${PRODUCT_NAME}’s \`workspace_state\` tool to check the configured compiler and engine. Follow the app’s preferences.
- ${PRODUCT_NAME} automatically compiles LaTeX and shows a live PDF preview.
- **Build Directory**: ${PRODUCT_NAME} stores persistent LaTeX build output in the OS app-cache directory, outside the project.
- **App Data**: ${PRODUCT_NAME} stores human and agent comments, automatic history, and chat sessions in the OS application-support directory, outside the project.
`;

// Settings save the instructions only when they differ from this default, so
// an untouched default follows the app. Tool and comment rules are not repeated
// here: every session already gets them from the app.
