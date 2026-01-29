import { useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../convex/api";
import { getElectronApi } from "../services/electron";
import { CredentialModal } from "../components/CredentialModal";

export type PendingCredentialRequest = {
  requestId: string;
  provider: string;
  label?: string;
  description?: string;
  placeholder?: string;
};

export const CredentialRequestLayer = () => {
  const createSecret = useMutation(api.secrets.createSecret);
  const [pending, setPending] = useState<PendingCredentialRequest | null>(null);

  const apiHandle = useMemo(() => getElectronApi(), []);

  useEffect(() => {
    if (!apiHandle?.onCredentialRequest) {
      return;
    }
    const unsubscribe = apiHandle.onCredentialRequest((_event, data) => {
      setPending(data);
    });
    return () => unsubscribe();
  }, [apiHandle]);

  const handleSubmit = async ({ label, secret }: { label: string; secret: string }) => {
    if (!pending) return;
    const result = await createSecret({
      provider: pending.provider,
      label,
      plaintext: secret,
    });

    await apiHandle?.submitCredential?.({
      requestId: pending.requestId,
      secretId: (result as { secretId: string }).secretId,
      provider: pending.provider,
      label,
    });
    setPending(null);
  };

  const handleCancel = async () => {
    if (!pending) return;
    await apiHandle?.cancelCredential?.({ requestId: pending.requestId });
    setPending(null);
  };

  return (
    <CredentialModal
      open={Boolean(pending)}
      provider={pending?.provider ?? ""}
      label={pending?.label}
      description={pending?.description}
      placeholder={pending?.placeholder}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
    />
  );
};
