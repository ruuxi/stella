import { MediaPreviewCard } from "@/shell/MediaPreviewCard";
import {
  mediaPreviewDialog,
  useMediaPreviewDialog,
} from "@/shell/media-preview-dialog-store";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/ui/dialog";

export function MediaPreviewDialog() {
  const { payload } = useMediaPreviewDialog();

  return (
    <Dialog
      open={Boolean(payload)}
      onOpenChange={(open) => {
        if (!open) mediaPreviewDialog.close();
      }}
    >
      {payload && (
        <DialogContent size="xl" fit>
          <DialogTitle>Preview</DialogTitle>
          <DialogDescription>
            Larger media preview.
          </DialogDescription>
          <DialogCloseButton />
          <DialogBody>
            <MediaPreviewCard
              asset={payload.asset}
              {...(payload.prompt ? { prompt: payload.prompt } : {})}
              {...(payload.capability ? { capability: payload.capability } : {})}
              {...(payload.initialIndex !== undefined
                ? { initialIndex: payload.initialIndex }
                : {})}
              inDialog
            />
          </DialogBody>
        </DialogContent>
      )}
    </Dialog>
  );
}
