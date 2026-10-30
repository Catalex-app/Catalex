import type { ContentBlock } from "@/stores/agent-chat-store";

/** Shared wording for expanded tool headers and the collapsed chat preview. */
export function toolTitle(tool: ContentBlock, result?: ContentBlock) {
  const input = tool.input;
  const name = tool.name || "unknown";
  const actions: Record<string, [string, string, string]> = {
    write: ["Writing", "Wrote", "file_path"],
    edit: ["Editing", "Edited", "file_path"],
    multiedit: ["Editing", "Edited", "file_path"],
    read: ["Reading", "Read", "file_path"],
    glob: ["Searching", "Searched", "pattern"],
    grep: ["Grepping", "Grepped", "pattern"],
  };
  const action = actions[name.toLowerCase()];
  if (action) {
    return {
      label: action[result ? 1 : 0],
      detail: String(input?.[action[2]] ?? ""),
    };
  }
  if (name.toLowerCase() === "bash") {
    const command = String(input?.command || input?.description || "");
    return {
      label: "$",
      detail: command.length > 80 ? `${command.slice(0, 80)}...` : command,
    };
  }
  if (name.toLowerCase() === "todowrite") {
    const todos = Array.isArray(input?.todos) ? input.todos : [];
    const completed = todos.filter(
      (todo: { status?: string }) => todo.status === "completed",
    ).length;
    return { label: `Todos (${completed}/${todos.length})`, detail: "" };
  }
  if (name.toLowerCase() === "askuserquestion") {
    return {
      label: input?.questions?.[0]?.question || "Awaiting your answer",
      detail: "",
    };
  }
  return { label: result ? "Ran" : "Running", detail: name };
}
