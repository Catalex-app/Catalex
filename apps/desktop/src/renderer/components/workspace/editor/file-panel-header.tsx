import { Hint } from "@/components/ui/tooltip";
import { type ReactNode } from "react";
import { WorkspacePanelHeader } from "../workspace-panel";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`;
  const unit = bytes < 1024 * 1024 ? 1024 : 1024 * 1024;
  return `${Number((bytes / unit).toFixed(1))} ${unit === 1024 ? "KB" : "MB"}`;
}

export function FilePanelHeader({
  fileName,
  fileSize,
  deleted = false,
  children,
  label = "File information",
}: {
  fileName?: string;
  fileSize?: number;
  deleted?: boolean;
  children?: ReactNode;
  label?: string;
}) {
  const baseName = fileName?.split(/[\\/]/).pop() ?? "";
  const extension = baseName.split(".").pop();
  const fileType = fileName
    ? baseName.lastIndexOf(".") > 0 && extension
      ? `${extension.toUpperCase()} file`
      : "File"
    : null;
  return (
    <WorkspacePanelHeader
      as="header"
      role="toolbar"
      aria-label={label}
      className="gap-1"
    >
      <Hint
        content={
          deleted
            ? "File deleted"
            : fileSize === undefined
              ? (fileType ?? undefined)
              : `${fileType ? `${fileType} · ` : ""}${fileSize.toLocaleString()} bytes`
        }
      >
        <span className="mr-auto min-w-0 truncate pr-2 text-muted-foreground text-xs">
          {fileType && `${fileType} · `}
          {deleted
            ? "Deleted"
            : fileSize === undefined
              ? "Size unavailable"
              : formatSize(fileSize)}
        </span>
      </Hint>
      {children}
    </WorkspacePanelHeader>
  );
}
