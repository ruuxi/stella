import * as DialogPrimitive from "@radix-ui/react-dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { cn } from "@/shared/lib/utils";
import { X } from "@/ui/icons";

interface ImageLightboxProps {
  /** Whether the enlarged preview is shown. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Image source to display at full size. */
  src: string;
  /** Accessible label / alt text for the previewed image. */
  alt?: string;
  className?: string;
}

/**
 * Full-window image preview built on the same Radix Dialog primitive the
 * rest of the app's modals use (`ui/dialog.tsx`), so it inherits the
 * canonical portal, focus trap, Esc-to-close, and click-outside-to-dismiss
 * behavior. The surface mirrors the dialog design tokens (scrim, blur,
 * radius, shadow, close-button styling, motion) defined in
 * `image-lightbox.css`.
 *
 * The image is sized with `max-width`/`max-height` against the viewport
 * and `width:auto/height:auto`, so it scales down to fit within a padded
 * window while preserving aspect ratio and never upscaling beyond its
 * intrinsic resolution.
 */
export function ImageLightbox({
  open,
  onOpenChange,
  src,
  alt,
  className,
}: ImageLightboxProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-component="image-lightbox-overlay" />
        <div data-component="image-lightbox">
          <DialogPrimitive.Content
            data-slot="image-lightbox-content"
            className={cn(className)}
            aria-label={alt || "Image preview"}
          >
            <VisuallyHidden asChild>
              <DialogPrimitive.Title>
                {alt || "Image preview"}
              </DialogPrimitive.Title>
            </VisuallyHidden>
            <img
              data-slot="image-lightbox-image"
              src={src}
              alt={alt ?? ""}
            />
            <DialogPrimitive.Close
              data-slot="image-lightbox-close"
              aria-label="Close preview"
            >
              <X size={18} />
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
