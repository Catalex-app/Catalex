import { PRODUCT_NAME } from "../../branding";
import { open as openExternal } from "@/lib/desktop/shell";
import {
  ArchiveIcon,
  BookOpenIcon,
  Building2Icon,
  CloudDownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GitBranchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EXTERNAL_TEMPLATE_SOURCES,
  type ExternalTemplateSource,
} from "@/lib/new-project-resources";

const SOURCE_ICONS: Record<
  ExternalTemplateSource["id"],
  React.ComponentType<{ className?: string }>
> = {
  "ctan-conference": ArchiveIcon,
  "ctan-journal": ArchiveIcon,
  ieee: Building2Icon,
  acm: BookOpenIcon,
  springer: BookOpenIcon,
  elsevier: BookOpenIcon,
};

interface TemplateDiscoveryGuideProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFolder?: () => void | Promise<void>;
}

function openInBrowser(url: string) {
  void openExternal(url).catch(() => {
    toast.error("Could not open the link", {
      description: "Please check your connection and try again.",
    });
  });
}

export function TemplateDiscoveryGuide({
  open,
  onOpenChange,
  onOpenFolder,
}: TemplateDiscoveryGuideProps) {
  const handleOpenFolder = () => {
    onOpenChange(false);
    void onOpenFolder?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="border-border/70 border-b px-6 py-5 pr-14">
          <DialogTitle>Publisher templates and Overleaf projects</DialogTitle>
          <DialogDescription>
            Find a venue-specific format, then bring its source files into
            {PRODUCT_NAME}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 py-5">
          <div className="flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/6 p-3.5">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="font-medium text-sm">
                Check the venue instructions first
              </p>
              <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                Conference and journal requirements change. Treat the official
                submission page as the final authority, even when a gallery
                labels a template as official.
              </p>
            </div>
          </div>

          <section aria-labelledby="template-sources-heading">
            <div className="mb-3">
              <h3
                id="template-sources-heading"
                className="font-semibold text-sm"
              >
                Trusted places to look
              </h3>
              <p className="mt-0.5 text-muted-foreground text-xs">
                These links open in your browser. Download the source when you
                find the right format.
              </p>
            </div>

            <div className="grid gap-2.5 sm:grid-cols-2">
              {EXTERNAL_TEMPLATE_SOURCES.map((source) => {
                const SourceIcon = SOURCE_ICONS[source.id];
                return (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => openInBrowser(source.url)}
                    className="group flex min-h-28 flex-col rounded-xl border border-border/80 bg-muted/15 p-3.5 text-left transition-colors hover:border-foreground/20 hover:bg-muted/35"
                    aria-label={`Open ${source.name} in your browser`}
                  >
                    <div className="flex w-full items-start gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background">
                        <SourceIcon className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">
                            {source.name}
                          </span>
                          <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                        </span>
                        <span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
                          {source.description}
                        </span>
                      </span>
                    </div>
                    <span className="mt-auto ml-12 inline-flex w-fit rounded-full bg-foreground/6 px-2 py-0.5 font-medium text-[10px] text-muted-foreground">
                      {source.badge}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section
            aria-labelledby="overleaf-import-heading"
            className="rounded-xl border border-border/80"
          >
            <div className="border-border/70 border-b px-4 py-3.5">
              <h3
                id="overleaf-import-heading"
                className="font-semibold text-sm"
              >
                Continue an Overleaf project in {PRODUCT_NAME}
              </h3>
              <p className="mt-0.5 text-muted-foreground text-xs">
                Choose the transfer method that matches your Overleaf plan.
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground/80">
                Direct Overleaf links are omitted pending the linking permission
                required by its current terms.
              </p>
            </div>

            <div className="grid divide-y divide-border/70 md:grid-cols-2 md:divide-x md:divide-y-0">
              <div className="p-4">
                <div className="flex items-center gap-2">
                  <CloudDownloadIcon className="size-4 text-muted-foreground" />
                  <h4 className="font-medium text-sm">
                    Download the source ZIP
                  </h4>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-[10px] text-emerald-700 dark:text-emerald-300">
                    Free plan
                  </span>
                </div>
                <ol className="mt-3 space-y-2 text-muted-foreground text-xs leading-relaxed">
                  <li>
                    1. In Overleaf, choose File → Download as source (.zip).
                  </li>
                  <li>2. Extract the downloaded ZIP on your computer.</li>
                  <li>3. Open the extracted folder in {PRODUCT_NAME}.</li>
                </ol>
                <p className="mt-3 text-[11px] text-muted-foreground/80">
                  In Overleaf Help, search for “Downloading a project” for the
                  current official instructions.
                </p>
              </div>

              <div className="p-4">
                <div className="flex items-center gap-2">
                  <GitBranchIcon className="size-4 text-muted-foreground" />
                  <h4 className="font-medium text-sm">Clone with Git</h4>
                  <span className="rounded-full bg-violet-500/10 px-2 py-0.5 font-medium text-[10px] text-violet-700 dark:text-violet-300">
                    Overleaf Premium
                  </span>
                </div>
                <ol className="mt-3 space-y-2 text-muted-foreground text-xs leading-relaxed">
                  <li>1. In Overleaf, open Integrations (or Menu) → Git.</li>
                  <li>2. Copy and run the provided clone command.</li>
                  <li>
                    3. Authenticate as “git” with your personal Overleaf token,
                    then open the cloned folder.
                  </li>
                </ol>
                <p className="mt-3 text-[11px] text-muted-foreground/80">
                  In Overleaf Help, search for “Git integration”. {PRODUCT_NAME}{" "}
                  never requests or stores your token.
                </p>
              </div>
            </div>
          </section>
        </div>

        <DialogFooter className="border-border/70 border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {onOpenFolder && (
            <Button onClick={handleOpenFolder}>
              <FolderOpenIcon className="size-4" />
              Open Folder
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
