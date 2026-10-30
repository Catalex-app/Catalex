import { Hint } from "@/components/ui/tooltip";
import { type FC, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { readImageAsDataUrl } from "@/lib/project-files";
import { cn } from "@/lib/utils";

interface ChatImagePreviewProps {
  src: string;
  alt?: string;
  sourcePath?: string;
  thumbnailClassName?: string;
  label?: string;
  tooltip?: string;
}

export const ChatImagePreview: FC<ChatImagePreviewProps> = ({
  src,
  alt,
  sourcePath,
  thumbnailClassName,
  label,
  tooltip,
}) => {
  const [open, setOpen] = useState(false);
  const [effectiveSrc, setEffectiveSrc] = useState(src);
  const [fallbackAttempted, setFallbackAttempted] = useState(false);
  const imageAlt = alt || "Image preview";

  useEffect(() => {
    setEffectiveSrc(src);
    setFallbackAttempted(false);
  }, [src]);

  const handleImageError = async () => {
    if (!sourcePath || fallbackAttempted) return;
    setFallbackAttempted(true);
    try {
      setEffectiveSrc(await readImageAsDataUrl(sourcePath));
    } catch {
      // Leave the failed source in place so the browser shows the normal error state.
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Hint content={tooltip}>
        <button
          type="button"
          data-testid="chat-image-preview-trigger"
          className="not-prose inline-flex min-w-0 max-w-full cursor-zoom-in items-center gap-1 rounded-lg text-left outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onClick={() => setOpen(true)}
        >
          <img
            src={effectiveSrc}
            alt={imageAlt}
            loading="lazy"
            onError={handleImageError}
            className={cn(
              "max-w-full rounded-lg border border-border bg-background object-contain",
              thumbnailClassName,
              label,
              tooltip,
            )}
          />
          {label && <span className="truncate">{label}</span>}
        </button>
      </Hint>
      <DialogContent
        className="w-auto max-w-[92vw] gap-0 overflow-visible border-none bg-transparent p-0 shadow-none sm:max-w-[92vw]"
        overlayClassName="bg-black/70"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{imageAlt}</DialogTitle>
        <img
          data-testid="chat-image-preview-dialog-image"
          src={effectiveSrc}
          alt={imageAlt}
          onError={handleImageError}
          className="max-h-[86vh] max-w-[92vw] rounded-lg bg-background object-contain shadow-2xl"
        />
      </DialogContent>
    </Dialog>
  );
};
