import { PopupSurface } from "@/components/ui/popup-surface";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { SelectionToolbar } from "@/components/workspace/editor/selection-toolbar";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useState } from "react";
import { MarkdownEditor } from "@/components/workspace/editor/markdown-editor";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Toaster } from "sonner";

export function ContextMenuHarness() {
  const [selectionPopup, setSelectionPopup] = useState(false);
  const [text, setText] = useState("alpha beta gamma");
  const [input, setInput] = useState("input selection");
  const [dark, setDark] = useState(false);
  const [opened, setOpened] = useState(0);
  return (
    <main className="min-h-screen space-y-6 bg-background p-12 text-foreground">
      <h1 className="font-semibold text-xl">Context menus</h1>
      <button
        onClick={() => {
          setDark(!dark);
          document.documentElement.classList.toggle("dark", !dark);
        }}
      >
        Toggle theme
      </button>
      <div className="rounded-md border p-4">
        <MarkdownEditor value={text} onChange={setText} ariaLabel="Document" />
      </div>
      <label className="block">
        Text input{" "}
        <input
          aria-label="Text input"
          className="rounded border p-2"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
      </label>
      <input aria-label="Read only" readOnly value="read only text" />
      <input aria-label="Password" type="password" defaultValue="secret" />
      <p className="select-text">Selectable reading text</p>
      <a
        href="https://example.com/reference"
        onClick={(event) => {
          event.preventDefault();
          setOpened(opened + 1);
        }}
      >
        Reference link
      </a>
      <output aria-label="Opened links">{opened}</output>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="rounded border p-4">Existing file menu</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Rename</ContextMenuItem>
          <ContextMenuItem>Move to Trash</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <div data-testid="empty" className="h-24">
        Empty workspace
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <button>Open dialog</button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Text dialog</DialogTitle>
          <DialogDescription>Menu focus check</DialogDescription>
          <textarea aria-label="Dialog input" defaultValue="dialog selection" />
        </DialogContent>
      </Dialog>
      <button onClick={() => setSelectionPopup(true)}>
        Show selection popup
      </button>
      {selectionPopup && (
        <SelectionToolbar
          position={{ top: 100, left: 550 }}
          contextLabel="Selection"
          actions={[{ id: "copy", label: "Copy", isAI: false, icon: null }]}
          onAction={() => setSelectionPopup(false)}
          onDismiss={() => setSelectionPopup(false)}
        />
      )}
      <div className="flex gap-4">
        <Popover>
          <PopoverTrigger>Glass popover</PopoverTrigger>
          <PopoverContent>Shared frosted popover</PopoverContent>
        </Popover>
        <Tooltip>
          <TooltipTrigger>Glass tooltip</TooltipTrigger>
          <TooltipContent>Shared frosted tooltip</TooltipContent>
        </Tooltip>
        <Select>
          <SelectTrigger aria-label="Glass select">
            <SelectValue placeholder="Choose an option" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="one">First option</SelectItem>
            <SelectItem value="two">Second option</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <PopupSurface
        data-testid="glass-override"
        className="fixed top-8 right-8 border-blue-500 bg-red-600 shadow-none"
      >
        Explicit surface override
      </PopupSurface>
      <Toaster />
    </main>
  );
}
