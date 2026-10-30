import { useAgentEvents } from "@/hooks/use-agent-events";
import { useEffect } from "react";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { useDocumentStore } from "@/stores/document-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

const SAMPLE_CSV = `Name,Role,Location,Notes
Ada Lovelace,Mathematician,London,"First programmer, analytical engine"
Grace Hopper,Computer scientist,New York,"COBOL pioneer"
Edsger Dijkstra,Computer scientist,Nuenen,"Structured programming"`;

function initializeCsvHarnessState() {
  useDocumentStore.setState({
    projectRoot: "/tmp/csv-workspace-harness",
    files: [
      {
        id: "people.csv",
        name: "people.csv",
        relativePath: "people.csv",
        absolutePath: "/tmp/csv-workspace-harness/people.csv",
        type: "csv",
        content: SAMPLE_CSV,
        isDirty: false,
      },
    ],
    folders: [],
    activeFileId: "people.csv",
    openFileIds: ["people.csv"],
    cursorPosition: 0,
    selectionRange: null,
    jumpToPosition: null,
    initialized: true,
  });
}

export function CsvWorkspaceHarness() {
  useAgentEvents();
  ensureDesktopBrowserMocks();

  useEffect(() => {
    initializeCsvHarnessState();
  }, []);

  return (
    <div
      className="h-screen min-h-0 bg-background"
      data-testid="csv-workspace-harness-shell"
    >
      <WorkspaceLayout />
    </div>
  );
}
