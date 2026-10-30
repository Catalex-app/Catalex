import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";
import { EditorToolbar } from "@/components/workspace/editor/editor-toolbar";
import { ExternalAppSelector } from "@/components/workspace/external-app-selector";
import { useDocumentStore } from "@/stores/document-store";
import { browserHarness } from "@/lib/desktop/bridge";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function FocusHarness() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    ensureDesktopBrowserMocks();
    const bridge = browserHarness();
    if (!bridge) return;
    const original = bridge.invoke;
    bridge.invoke = async (command, ...args) =>
      command === "detect_editors"
        ? [
            { id: "finder", name: "Finder" },
            { id: "vscode", name: "VS Code" },
          ]
        : original(command, ...args);
    const files = ["conference.tex", "references.bib"].map((name) => ({
      id: name,
      name,
      relativePath: name,
      absolutePath: `/tmp/focus/${name}`,
      type: "tex" as const,
      content: "",
      isDirty: false,
    }));
    useDocumentStore.setState({
      files,
      projectRoot: "/tmp/focus",
      activeFileId: files[0].id,
      openFileIds: files.map((file) => file.id),
    });
    setReady(true);
    return () => {
      bridge.invoke = original;
    };
  }, []);
  return (
    <main className="min-h-screen bg-background p-12 text-foreground">
      <h1 className="mb-8 font-semibold text-lg">Keyboard focus</h1>
      <div className="flex items-center gap-6">
        <Button>Save</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="git-actions-menu">
              Actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>First action</DropdownMenuItem>
            <DropdownMenuItem>Second action</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Select defaultValue="latex">
          <SelectTrigger aria-label="Format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="latex">LaTeX</SelectItem>
            <SelectItem value="markdown">Markdown</SelectItem>
          </SelectContent>
        </Select>
        <Input
          aria-label="Project name"
          placeholder="Project name"
          className="w-48"
        />
        <Button disabled>Disabled</Button>
      </div>
      <div className="mt-8 flex gap-4">
        <button type="button" className="rounded-md px-3 py-1">
          Manual
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          className="rounded-md px-3 py-1 focus-visible:ring-2 focus-visible:ring-ring"
        >
          Artisan
        </button>
      </div>
      {ready && (
        <div
          className="mt-8 flex h-10 items-center gap-6"
          data-focus-workspace-controls
        >
          <ExternalAppSelector />
          <EditorToolbar />
        </div>
      )}
      <p className="mt-16 text-muted-foreground">Empty space for dismissal</p>
    </main>
  );
}
