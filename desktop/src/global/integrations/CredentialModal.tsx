import { useState } from "react";
import { KeyRound } from "lucide-react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogCloseButton,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { getProviderDisplayName } from "@/global/settings/lib/model-catalog";
import "./credential-modal.css";

type CredentialModalProps = {
  open: boolean;
  provider: string;
  label?: string;
  description?: string;
  placeholder?: string;
  /**
   * Show the "Label" field. Connector credentials don't need it (the
   * tokenKey is the identifier and there's only one credential per
   * connector); the legacy `RequestCredential` flow does because users
   * may have multiple keys for the same provider.
   */
  showLabel?: boolean;
  onSubmit: (payload: { label: string; secret: string }) => Promise<void>;
  onCancel: () => void;
};

type CredentialModalContentProps = Omit<CredentialModalProps, "open">;

const CredentialModalContent = ({
  provider,
  label,
  description,
  placeholder,
  showLabel = true,
  onSubmit,
  onCancel,
}: CredentialModalContentProps) => {
  const [secret, setSecret] = useState("");
  const [labelValue, setLabelValue] = useState(label ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const providerTitle = label?.trim() || getProviderDisplayName(provider);

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setError(null);
    if (!secret.trim()) {
      setError("API key is required.");
      return;
    }
    const finalLabel = labelValue.trim() || `${providerTitle} key`;
    try {
      setSubmitting(true);
      await onSubmit({ label: finalLabel, secret: secret.trim() });
    } catch (err) {
      setError((err as Error).message || "Failed to save credential.");
      setSubmitting(false);
    }
  };

  return (
    <>
      <VisuallyHidden asChild>
        <DialogTitle>Connect {providerTitle}</DialogTitle>
      </VisuallyHidden>
      <VisuallyHidden asChild>
        <DialogDescription>
          {description ??
            `Stella needs your ${providerTitle} API key to connect. Paste it below. It stays on your computer.`}
        </DialogDescription>
      </VisuallyHidden>
      <DialogCloseButton className="credential-modal-close" />
      <DialogBody className="credential-modal-body">
        <div className="credential-modal-hero">
          <div className="credential-modal-icon">
            <KeyRound size={20} />
          </div>
          <p className="credential-modal-headline">Connect {providerTitle}</p>
          <p className="credential-modal-sub">
            {description ??
              `Stella needs your ${providerTitle} API key to connect. Paste it below. It stays on your computer.`}
          </p>
        </div>

        <form className="credential-modal-form" onSubmit={handleSubmit}>
          <TextField
            label="API key"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={placeholder ?? "Paste your key"}
            autoFocus
          />
          {showLabel ? (
            <TextField
              label="Label"
              description="A friendly name to recognize this key later."
              value={labelValue}
              onChange={(event) => setLabelValue(event.target.value)}
              placeholder={`${providerTitle} key`}
            />
          ) : null}
          {error ? <div className="credential-modal-error">{error}</div> : null}

          <div className="credential-modal-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={submitting}
              className="pill-btn pill-btn--lg credential-modal-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting}
              className="pill-btn pill-btn--primary pill-btn--lg credential-modal-submit"
            >
              {submitting ? "Saving..." : "Save key"}
            </Button>
          </div>
        </form>
      </DialogBody>
    </>
  );
};

export const CredentialModal = ({
  open,
  provider,
  label,
  description,
  placeholder,
  showLabel,
  onSubmit,
  onCancel,
}: CredentialModalProps) => {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}
    >
      <DialogContent fit className="credential-modal-content">
        {open ? (
          <CredentialModalContent
            key={`${provider}-${label ?? ""}`}
            provider={provider}
            label={label}
            description={description}
            placeholder={placeholder}
            showLabel={showLabel}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
