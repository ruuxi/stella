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
import "./credential-modal.css";

type CredentialModalProps = {
  open: boolean;
  provider: string;
  label?: string;
  description?: string;
  placeholder?: string;
  onSubmit: (payload: { label: string; secret: string }) => Promise<void>;
  onCancel: () => void;
};

type CredentialModalContentProps = Omit<CredentialModalProps, "open">;

function formatProviderName(provider: string): string {
  return provider
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const CredentialModalContent = ({
  provider,
  label,
  description,
  placeholder,
  onSubmit,
  onCancel,
}: CredentialModalContentProps) => {
  const [secret, setSecret] = useState("");
  const [labelValue, setLabelValue] = useState(label ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const providerTitle = label?.trim() || formatProviderName(provider);

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
            "Enter your API key. It is stored securely and never shown to the AI."}
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
              "Paste your API key. It's stored securely on your device and never shown to the AI."}
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
          <TextField
            label="Label"
            description="A friendly name to recognize this key later."
            value={labelValue}
            onChange={(event) => setLabelValue(event.target.value)}
            placeholder={`${providerTitle} key`}
          />
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
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
