import { Globe } from "lucide-react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import "./credential-modal.css";

type ConnectorOAuthDialogProps = {
  open: boolean;
  displayName: string;
  /** Optional sub copy override; defaults to the canonical normie line. */
  description?: string;
  onCancel: () => void;
};

/**
 * The OAuth twin of `CredentialModal`. No input field — the browser is
 * the auth surface — just a "Connecting <X>…" indicator and Cancel.
 * Visually mirrors `CredentialModal` (same CSS module, same glass
 * shell) so the api_key and oauth flows look like the same surface
 * from the user's perspective.
 *
 * Reused for any `connector-credential:request` with `mode: "oauth"`.
 * Cancel propagates through `ConnectorCredentialService.cancelCredential`
 * which aborts the underlying `connectConnectorOAuth` flow.
 */
export const ConnectorOAuthDialog = ({
  open,
  displayName,
  description,
  onCancel,
}: ConnectorOAuthDialogProps) => {
  const sub =
    description ??
    `Stella opened ${displayName} in your browser. Sign in there to connect. The browser tab will close once it's done.`;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}
    >
      <DialogContent fit className="credential-modal-content">
        <VisuallyHidden asChild>
          <DialogTitle>Connecting {displayName}</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>{sub}</DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="credential-modal-close" />
        <DialogBody className="credential-modal-body">
          <div className="credential-modal-hero">
            <div className="credential-modal-icon">
              <Globe size={20} />
            </div>
            <p className="credential-modal-headline">Connecting {displayName}</p>
            <p className="credential-modal-sub">{sub}</p>
          </div>

          <div className="credential-modal-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              className="pill-btn pill-btn--lg credential-modal-cancel"
            >
              Cancel
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
