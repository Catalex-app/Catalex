import { FileIcon } from "lucide-react";
import { type ProjectFile } from "@/stores/document-store";
import { FilePanelHeader } from "./file-panel-header";

export function FilePreview({ file }: { file: ProjectFile }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilePanelHeader fileName={file.name} fileSize={file.fileSize} />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-muted-foreground">
        <FileIcon className="size-8" />
        <p className="text-sm">No preview available</p>
      </div>
    </div>
  );
}
