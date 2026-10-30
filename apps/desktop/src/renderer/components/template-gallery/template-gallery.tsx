import { PRODUCT_NAME } from "../../../branding";
import {
  canHandleEscape,
  consumeKey,
  isComposingKey,
} from "@/lib/keyboard-events";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  BookOpenCheckIcon,
  SearchIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TrafficLightSafeHeader } from "@/components/window-titlebar";
import { useTemplateStore } from "@/stores/template-store";
import {
  CATEGORY_LABELS,
  type TemplateCategory,
} from "@/lib/template-registry";
import { TemplateCard } from "./template-card";
import { CategorySidebar } from "./category-sidebar";
import { TemplatePreview } from "./template-preview";
import { TemplateDiscoveryGuide } from "@/components/template-discovery-guide";

interface TemplateGalleryProps {
  onBack: () => void;
  onOpenFolder?: () => void | Promise<void>;
}

export function TemplateGallery({
  onBack,
  onOpenFolder,
}: TemplateGalleryProps) {
  const searchQuery = useTemplateStore((s) => s.searchQuery);
  const setSearchQuery = useTemplateStore((s) => s.setSearchQuery);
  const selectedCategory = useTemplateStore((s) => s.selectedCategory);
  const filteredTemplates = useTemplateStore((s) => s.filteredTemplates);
  const reset = useTemplateStore((s) => s.reset);
  const [showTemplateDiscovery, setShowTemplateDiscovery] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // Reset store when gallery mounts
  useEffect(() => {
    reset();
  }, [reset]);

  // Focus search on Cmd/Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isComposingKey(e) || e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      // Escape clears search
      if (canHandleEscape(e) && document.activeElement === searchRef.current) {
        consumeKey(e);
        setSearchQuery("");
        searchRef.current?.blur();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSearchQuery]);

  // Group templates by category when showing all
  const showGrouped = !selectedCategory && !searchQuery;

  const heading = selectedCategory
    ? CATEGORY_LABELS[selectedCategory]
    : searchQuery
      ? `Results for "${searchQuery}"`
      : "All Templates";

  return (
    <div
      className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)] bg-background px-2 text-foreground"
      data-testid="template-gallery"
    >
      <aside className="flex min-h-0 flex-col" data-testid="template-sidebar">
        <TrafficLightSafeHeader>
          <Button
            variant="ghost"
            size="icon"
            className="-ml-1 size-7 rounded-lg"
            onClick={onBack}
            aria-label="Back to welcome"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
        </TrafficLightSafeHeader>
        <div className="min-h-0 flex-1 pb-2">
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex h-8 shrink-0 items-center justify-center gap-2 px-3">
              <SparklesIcon className="size-3.5 text-muted-foreground" />
              <span className="font-semibold text-xs">Template Library</span>
            </div>
            <div className="mx-3 border-sidebar-border border-t" />
            <div className="min-h-0 flex-1">
              <CategorySidebar />
            </div>
          </div>
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col pb-2">
        <div className="flex h-10 shrink-0 items-center gap-3 pr-2 pl-2">
          <h1 className="truncate font-semibold text-sm">Choose a Template</h1>
          <div
            data-window-drag-region
            className="min-w-0 flex-1 self-stretch"
          />
        </div>

        <div className="min-h-0 flex-1 pr-0">
          <div
            className="flex h-full min-h-0 flex-col overflow-hidden rounded-panel border border-border/70 bg-muted/25"
            data-testid="template-gallery-surface"
          >
            {/* Search bar */}
            <div className="shrink-0 border-border/60 border-b bg-background/55 px-4 py-3">
              <div className="mx-auto flex max-w-4xl items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchRef}
                    placeholder={"Search " + PRODUCT_NAME + " templates...  ⌘K"}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-background pr-8 pl-9"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery("")}
                      className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label="Clear template search"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 bg-background"
                  onClick={() => setShowTemplateDiscovery(true)}
                >
                  <BookOpenCheckIcon className="size-4" />
                  <span className="hidden min-[760px]:inline">
                    Publisher &amp; Overleaf
                  </span>
                  <span className="min-[760px]:hidden">Sources</span>
                </Button>
              </div>
            </div>

            {/* Template grid */}
            <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4 min-[1180px]:px-5">
              {filteredTemplates.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <SearchIcon className="mb-3 size-8 text-muted-foreground/40" />
                  <p className="font-medium text-muted-foreground text-sm">
                    No {PRODUCT_NAME} templates found
                  </p>
                  <p className="mt-1 text-muted-foreground/70 text-xs">
                    {searchQuery
                      ? `No built-in templates match “${searchQuery}”.`
                      : "Try a different search term or category."}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4 bg-background"
                    onClick={() => setShowTemplateDiscovery(true)}
                  >
                    <BookOpenCheckIcon className="size-4" />
                    Browse trusted sources
                  </Button>
                </div>
              ) : showGrouped ? (
                <GroupedGrid />
              ) : (
                <>
                  <h2 className="mb-4 font-medium text-muted-foreground text-sm">
                    {heading}
                  </h2>
                  <TemplateGrid>
                    {filteredTemplates.map((t) => (
                      <TemplateCard key={t.id} template={t} />
                    ))}
                  </TemplateGrid>
                </>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Preview modal — handles template selection + project creation */}
      <TemplatePreview />
      <TemplateDiscoveryGuide
        open={showTemplateDiscovery}
        onOpenChange={setShowTemplateDiscovery}
        onOpenFolder={onOpenFolder}
      />
    </div>
  );
}

function TemplateGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-4 min-[1180px]:grid-cols-4 min-[900px]:grid-cols-3">
      {children}
    </div>
  );
}

// ─── Grouped Grid (shows categories as sections) ───

function GroupedGrid() {
  const filteredTemplates = useTemplateStore((s) => s.filteredTemplates);

  // Group by category preserving order
  const categories: TemplateCategory[] = [
    "academic",
    "professional",
    "creative",
    "starter",
  ];
  const groups = categories
    .map((cat) => ({
      category: cat,
      templates: filteredTemplates.filter((t) => t.category === cat),
    }))
    .filter((g) => g.templates.length > 0);

  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <div key={group.category}>
          <h2 className="mb-3 font-semibold text-sm">
            {CATEGORY_LABELS[group.category]}
          </h2>
          <TemplateGrid>
            {group.templates.map((t) => (
              <TemplateCard key={t.id} template={t} />
            ))}
          </TemplateGrid>
        </div>
      ))}
    </div>
  );
}
