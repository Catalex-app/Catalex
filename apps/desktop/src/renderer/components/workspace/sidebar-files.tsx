import { Hint } from "@/components/ui/tooltip";
import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
} from "lucide-react";
import { isMarkdownFile } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { ProjectFile } from "@/stores/document-store";
import {
  SidebarRow,
  SidebarRowIcon,
  SidebarSectionBody,
  SidebarSectionHeader,
  SidebarTreeGuide,
} from "./sidebar-layout";

/** File identity and appearance, independent of a live document or filesystem. */
export type SidebarFile = Pick<
  ProjectFile,
  "id" | "name" | "relativePath" | "type"
>;

export interface SidebarFileTreeNode<TFile extends SidebarFile = SidebarFile> {
  name: string;
  relativePath: string;
  type: "folder" | "file";
  file?: TFile;
  children: SidebarFileTreeNode<TFile>[];
}

export function buildFileTree<TFile extends SidebarFile>(
  files: readonly TFile[],
  folders: readonly string[],
): SidebarFileTreeNode<TFile>[] {
  const root: SidebarFileTreeNode<TFile>[] = [];
  const folderMap = new Map<string, SidebarFileTreeNode<TFile>>();

  function getOrCreateFolder(path: string): SidebarFileTreeNode<TFile>[] {
    if (!path) return root;
    if (folderMap.has(path)) return folderMap.get(path)!.children;
    const parts = path.split("/");
    const folder: SidebarFileTreeNode<TFile> = {
      name: parts[parts.length - 1],
      relativePath: path,
      type: "folder",
      children: [],
    };
    const parentChildren = getOrCreateFolder(parts.slice(0, -1).join("/"));
    folderMap.set(path, folder);
    parentChildren.push(folder);
    return folder.children;
  }

  for (const folderPath of folders) getOrCreateFolder(folderPath);
  for (const file of files) {
    const parts = file.relativePath.split("/");
    getOrCreateFolder(parts.slice(0, -1).join("/")).push({
      name: parts[parts.length - 1],
      relativePath: file.relativePath,
      type: "file",
      file,
      children: [],
    });
  }

  function sortNodes(nodes: SidebarFileTreeNode<TFile>[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.type === "folder") sortNodes(node.children);
    }
  }
  sortNodes(root);
  return root;
}

export function getFileIcon(file: SidebarFile, className?: string) {
  if (file.type === "image")
    return <ImageIcon className={cn("size-4 shrink-0", className)} />;
  if (file.type === "csv" || file.type === "pdf")
    return <FileSpreadsheetIcon className={cn("size-4 shrink-0", className)} />;
  if (file.type === "style")
    return <FileCodeIcon className={cn("size-4 shrink-0", className)} />;
  if (isMarkdownFile(file))
    return <FileTextIcon className={cn("size-4 shrink-0", className)} />;
  if (file.type === "other")
    return <FileIcon className={cn("size-4 shrink-0", className)} />;
  return <FileTextIcon className={cn("size-4 shrink-0", className)} />;
}

type FileRowProps = Omit<ComponentProps<"button">, "children" | "onClick"> & {
  [key: `data-${string}`]: string | boolean | undefined;
};

interface FileAppearanceProps<TFile extends SidebarFile> {
  renderFileBadge?: (file: TFile) => ReactNode;
  fileRowProps?: (file: TFile) => FileRowProps;
  fileTextClassName?: (file: TFile) => string | undefined;
  folderIconClassName?: (
    node: SidebarFileTreeNode<TFile>,
  ) => string | undefined;
  folderTextClassName?: (
    node: SidebarFileTreeNode<TFile>,
  ) => string | undefined;
}

interface SidebarFileTreeProps<TFile extends SidebarFile>
  extends FileAppearanceProps<TFile> {
  tree: readonly SidebarFileTreeNode<TFile>[];
  activeFileId: string;
  expandedFolders: ReadonlySet<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (id: string) => void;
  onOpenFileInBackground?: (id: string) => void;
}

/** Shared non-mutating rows; consumers supply only selection and appearance. */
export function SidebarFileTree<TFile extends SidebarFile>({
  tree,
  activeFileId,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  onOpenFileInBackground,
  renderFileBadge,
  fileRowProps,
  fileTextClassName,
  folderTextClassName,
  folderIconClassName,
}: SidebarFileTreeProps<TFile>) {
  function renderNode(
    node: SidebarFileTreeNode<TFile>,
    depth: number,
  ): ReactNode {
    if (node.type === "folder") {
      const isExpanded = expandedFolders.has(node.relativePath);
      return (
        <div key={node.relativePath} className="relative">
          {isExpanded && node.children.length > 0 && (
            <SidebarTreeGuide depth={depth} data-folder-guide={depth} />
          )}
          <SidebarRow
            className="py-1.5"
            aria-expanded={isExpanded}
            depth={depth}
            onClick={() => onToggleFolder(node.relativePath)}
          >
            <SidebarRowIcon
              className={cn(
                "text-muted-foreground",
                folderIconClassName?.(node),
              )}
            >
              {isExpanded ? (
                <ChevronDownIcon className="size-4" />
              ) : (
                <ChevronRightIcon className="size-4" />
              )}
            </SidebarRowIcon>
            <span className={cn("truncate", folderTextClassName?.(node))}>
              {node.name}
            </span>
          </SidebarRow>
          {isExpanded
            ? node.children.map((child) => renderNode(child, depth + 1))
            : null}
        </div>
      );
    }

    const file = node.file!;
    const { className, title, ...rowProps } = fileRowProps?.(file) ?? {};
    const textClassName = fileTextClassName?.(file);
    const badge = renderFileBadge?.(file);
    return (
      <Hint content={title ?? file.relativePath} key={node.relativePath}>
        <SidebarRow
          data-sidebar-file-id={encodeURIComponent(file.id)}
          data-middle-click-tab={onOpenFileInBackground ? "" : undefined}
          aria-current={file.id === activeFileId ? "true" : undefined}
          {...rowProps}
          className={cn(
            "py-1.5",
            file.id === activeFileId
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent/50",
            className,
          )}
          trailing={
            badge ? (
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {badge}
              </div>
            ) : undefined
          }
          depth={depth}
          onClick={() => onSelectFile(file.id)}
          onAuxClick={(event) => {
            if (event.button !== 1 || !onOpenFileInBackground) return;
            event.preventDefault();
            event.stopPropagation();
            onOpenFileInBackground(file.id);
          }}
        >
          <SidebarRowIcon>{getFileIcon(file, textClassName)}</SidebarRowIcon>
          <span className={cn("min-w-0 flex-1 truncate", textClassName)}>
            {node.name}
          </span>
        </SidebarRow>
      </Hint>
    );
  }

  return tree.map((node) => renderNode(node, 0));
}

interface SidebarFilesProps<TFile extends SidebarFile>
  extends FileAppearanceProps<TFile> {
  files: readonly TFile[];
  folders?: readonly string[];
  activeFileId: string;
  onSelectFile: (id: string) => void;
  description?: ReactNode;
  className?: string;
  emptyState?: ReactNode;
}

const NO_FOLDERS: readonly string[] = [];

/** Files-only sidebar for read-only workspaces, without live project effects. */
export function SidebarFiles<TFile extends SidebarFile>({
  files,
  folders = NO_FOLDERS,
  activeFileId,
  onSelectFile,
  description,
  className,
  emptyState = "No recorded files",
  ...appearance
}: SidebarFilesProps<TFile>) {
  const tree = useMemo(() => buildFileTree(files, folders), [files, folders]);
  const selectedPath = files.find(
    (file) => file.id === activeFileId,
  )?.relativePath;
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    if (!selectedPath?.includes("/")) return;
    const parts = selectedPath.split("/");
    setExpandedFolders((current) => {
      const next = new Set(current);
      for (let depth = 1; depth < parts.length; depth++) {
        next.add(parts.slice(0, depth).join("/"));
      }
      return next;
    });
  }, [selectedPath]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-sidebar", className)}>
      <SidebarSectionHeader
        section="files"
        title="Files"
        icon={<FolderIcon className="size-3.5" />}
      />
      {description ? (
        <div className="px-2 pt-1 pb-2 text-muted-foreground text-xs">
          {description}
        </div>
      ) : null}
      <SidebarSectionBody
        className="app-scrollbar min-h-0 flex-1 overflow-y-auto"
        data-sidebar-files
      >
        {tree.length ? (
          <SidebarFileTree
            tree={tree}
            activeFileId={activeFileId}
            expandedFolders={expandedFolders}
            onToggleFolder={(path) =>
              setExpandedFolders((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            onSelectFile={onSelectFile}
            {...appearance}
          />
        ) : (
          <div className="px-2 py-3 text-muted-foreground text-xs">
            {emptyState}
          </div>
        )}
      </SidebarSectionBody>
    </div>
  );
}
