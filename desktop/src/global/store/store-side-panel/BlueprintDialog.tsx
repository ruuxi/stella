import { Markdown } from "@/app/chat/Markdown";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import type { StoreThreadMessage } from "./types";

type BlueprintDialogProps = {
  open: boolean;
  message: StoreThreadMessage | null;
  /** True only for the most recent non-denied blueprint draft. */
  canApprove: boolean;
  denying: boolean;
  onClose: () => void;
  onApprove: () => void;
  onDeny: () => void;
  onEdit: () => void;
};

export function BlueprintDialog({
  open,
  message,
  canApprove,
  denying,
  onClose,
  onApprove,
  onDeny,
  onEdit,
}: BlueprintDialogProps) {
  const denied = Boolean(message?.denied);
  const published = Boolean(message?.published);
  const titleSuffix = denied
    ? " (denied)"
    : published
      ? ` (published${message?.publishedReleaseNumber ? ` v${message.publishedReleaseNumber}` : ""})`
      : "";
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent fit className="store-blueprint-dialog">
        <DialogHeader>
          <DialogTitle>Blueprint draft{titleSuffix}</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          <div className="store-blueprint-dialog-viewer">
            {message ? (
              <Markdown text={message.text} cacheKey={message._id} />
            ) : null}
          </div>
          <div className="store-blueprint-dialog-actions">
            <button
              type="button"
              className="pill-btn"
              onClick={onEdit}
              disabled={!message || denying}
            >
              Edit
            </button>
            <button
              type="button"
              className="pill-btn pill-btn--danger"
              onClick={onDeny}
              disabled={!canApprove || denying}
            >
              {denying ? "Denying…" : "Deny"}
            </button>
            <button
              type="button"
              className="pill-btn pill-btn--primary"
              onClick={onApprove}
              disabled={!canApprove || denying}
              title={
                canApprove
                  ? "Open the publish form"
                  : denied
                    ? "This draft was denied. Pick the latest draft to publish."
                    : "Only the latest draft can be published."
              }
            >
              Approve & publish
            </button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
