import { useState } from "react";
import { Dialog } from "./dialog";

export type CredentialModalProps = {
  open: boolean;
  provider: string;
  label?: string;
  description?: string;
  placeholder?: string;
  onSubmit: (payload: { label: string; secret: string }) => Promise<void>;
  onCancel: () => void;
};

type CredentialModalContentProps = Omit<CredentialModalProps, "open">;

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

  const handleSubmit = async () => {
    setError(null);
    if (!secret.trim()) {
      setError("API key is required.");
      return;
    }
    const finalLabel = labelValue.trim() || `${provider} key`;
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
      <Dialog.Header>
        <Dialog.Title>Connect {provider}</Dialog.Title>
        <Dialog.Description>
          {description ?? "Enter your API key. This is stored securely and never shown to the AI."}
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Body>
        <label className="credential-field">
          <span className="credential-label">Label</span>
          <input
            value={labelValue}
            onChange={(event) => setLabelValue(event.target.value)}
            placeholder={`${provider} key`}
          />
        </label>
        <label className="credential-field">
          <span className="credential-label">API key</span>
          <input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={placeholder ?? "Paste your key"}
          />
        </label>
        {error ? <div className="credential-error">{error}</div> : null}
      </Dialog.Body>
      <div className="credential-actions">
        <button className="ghost-button" type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? "Saving..." : "Save"}
        </button>
      </div>
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
    <Dialog open={open} onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}>
      <Dialog.Content className="credential-modal">
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
      </Dialog.Content>
    </Dialog>
  );
};
