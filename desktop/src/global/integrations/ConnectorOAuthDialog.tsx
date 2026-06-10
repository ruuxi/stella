import { useState } from "react";
import { ExternalLink, Globe } from "@/ui/icons";
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
  oauthUserCode?: string;
  oauthVerificationUri?: string;
  waitForCompletion?: boolean;
  onOpenExternal: () => Promise<void>;
  onCancel: () => void;
};

/**
 * The OAuth twin of `CredentialModal`. It uses the same glass shell and
 * action language, but asks before opening the provider in the user's
 * browser. Some callers keep the dialog open while Stella waits for the
 * OAuth callback; approval-only callers close it after the browser launch.
 *
 * Reused for any `connector-credential:request` with `mode: "oauth"`.
 * Cancel propagates through `ConnectorCredentialService.cancelCredential`
 * which aborts the underlying `connectConnectorOAuth` flow.
 */
export const ConnectorOAuthDialog = ({
  open,
  displayName,
  description,
  oauthUserCode,
  oauthVerificationUri,
  waitForCompletion = true,
  onOpenExternal,
  onCancel,
}: ConnectorOAuthDialogProps) => {
  const [opening, setOpening] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const introSub =
    description ??
    `Stella needs to open ${displayName} in your browser so you can sign in and approve the connection.`;
  const waitingSub = `Finish signing in to ${displayName} in your browser. Stella will continue once the connection is approved.`;

  const handleOpenExternal = async () => {
    setError(null);
    setOpening(true);
    try {
      await onOpenExternal();
      if (waitForCompletion) {
        setWaiting(true);
      }
    } catch (err) {
      setError((err as Error).message || "Could not open the browser.");
    } finally {
      setOpening(false);
    }
  };

  const headline = waiting
    ? `Waiting for ${displayName}`
    : `Connect ${displayName}`;
  const sub = waiting ? waitingSub : introSub;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}
    >
      <DialogContent fit className="credential-modal-content">
        <VisuallyHidden asChild>
          <DialogTitle>{headline}</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>{sub}</DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="credential-modal-close" />
        <DialogBody className="credential-modal-body">
          <div className="credential-modal-hero">
            <div className="credential-modal-icon">
              {waiting ? <Globe size={20} /> : <ExternalLink size={20} />}
            </div>
            <p className="credential-modal-headline">{headline}</p>
            <p className="credential-modal-sub">{sub}</p>
          </div>
          {oauthUserCode ? (
            <div className="credential-modal-oauth-code">
              <span className="credential-modal-oauth-code-label">
                Use this code
              </span>
              <code>{oauthUserCode}</code>
              {oauthVerificationUri ? (
                <span className="credential-modal-oauth-code-uri">
                  {oauthVerificationUri}
                </span>
              ) : null}
            </div>
          ) : null}
          {error ? <div className="credential-modal-error">{error}</div> : null}

          <div className="credential-modal-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={opening}
              className="pill-btn pill-btn--lg credential-modal-cancel"
            >
              Cancel
            </Button>
            {!waiting ? (
              <Button
                type="button"
                variant="primary"
                onClick={handleOpenExternal}
                disabled={opening}
                className="pill-btn pill-btn--primary pill-btn--lg credential-modal-submit"
              >
                {opening ? "Opening..." : "Open browser"}
              </Button>
            ) : null}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
