/**
 * Pops `CredentialModal` when the runtime's CLI bridge requests an
 * MCP/REST connector credential — `stella-connect` hit a 401/403 and
 * needs the user to paste an API key.
 *
 * Unlike `CredentialRequestLayer`, the raw value is sent straight back
 * to the main process which writes it to `state/connectors/.credentials.json`
 * via `saveConnectorAccessToken`. Nothing touches Convex's `secrets`
 * table, and the bridge gets `{ ok: true }` once the file write
 * completes so it can retry the original CLI call inline.
 */

import { useCallback, useEffect, useState } from "react";
import { getElectronApi } from "@/platform/electron/electron";
import { CredentialModal } from "@/global/integrations/CredentialModal";
import { ConnectorOAuthDialog } from "@/global/integrations/ConnectorOAuthDialog";

type PendingConnectorCredentialRequest = {
  requestId: string;
  tokenKey: string;
  displayName: string;
  mode: "api_key" | "oauth";
  description?: string;
  placeholder?: string;
};

export const ConnectorCredentialRequestLayer = () => {
  // FIFO queue. We can only show one modal at a time, but multiple
  // agents / CLI calls can hit auth concurrently — each one has its own
  // pending entry in `ConnectorCredentialService`. If we just clobbered
  // the head, the displaced request would silently sit on the service
  // side until its 5-minute timeout and the CLI on the other end would
  // hang the same length of time. Queueing keeps every prompt's tab
  // open: head is shown, tail waits, head pops on submit/cancel.
  const [queue, setQueue] = useState<PendingConnectorCredentialRequest[]>([]);
  const pending = queue[0] ?? null;

  const apiHandle = getElectronApi();

  useEffect(() => {
    const systemApi = apiHandle?.system;
    if (!systemApi?.onConnectorCredentialRequest) {
      return;
    }
    const unsubscribe = systemApi.onConnectorCredentialRequest((_event, data) => {
      setQueue((current) => {
        // Same requestId arriving twice would be a main-process bug, but
        // dedupe defensively rather than render two overlapping dialogs
        // when state updates batch oddly.
        if (current.some((entry) => entry.requestId === data.requestId)) {
          return current;
        }
        return [...current, data];
      });
    });
    return () => unsubscribe();
  }, [apiHandle]);

  const dropHead = useCallback((requestId: string) => {
    setQueue((current) =>
      current[0]?.requestId === requestId ? current.slice(1) : current,
    );
  }, []);

  const handleSubmit = async ({
    label,
    secret,
  }: {
    label: string;
    secret: string;
  }) => {
    if (!pending) return;
    const result = await apiHandle?.system.submitConnectorCredential?.({
      requestId: pending.requestId,
      value: secret,
      label,
    });
    if (result && result.ok === false) {
      // Service kept the bridge entry alive (recoverable error). Let
      // CredentialModal surface the error and stay open so the user can
      // retry with the same `requestId`.
      throw new Error(result.error ?? "Could not save the connector credential.");
    }
    dropHead(pending.requestId);
  };

  const handleCancel = async () => {
    if (!pending) return;
    await apiHandle?.system.cancelConnectorCredential?.({
      requestId: pending.requestId,
    });
    dropHead(pending.requestId);
  };

  if (!pending) return null;

  // OAuth and api_key share the queue, IPC, and cancel/submit wiring;
  // only the surface differs. `key={requestId}` keeps the closing
  // dialog's prefilled state from bleeding into the next queued one
  // for either path.
  if (pending.mode === "oauth") {
    return (
      <ConnectorOAuthDialog
        key={pending.requestId}
        open={true}
        displayName={pending.displayName}
        description={pending.description}
        onCancel={handleCancel}
      />
    );
  }

  return (
    // `showLabel={false}` because connector credentials are 1:1 with
    // `tokenKey` — there is no second key to disambiguate, so the Label
    // field is just noise. Description left undefined so the modal's
    // canonical "Stella needs your <X> API key to connect…" sub copy
    // fires; overriding it here would just risk drifting.
    <CredentialModal
      key={pending.requestId}
      open={true}
      provider={pending.tokenKey}
      label={pending.displayName}
      description={pending.description}
      placeholder={pending.placeholder ?? "Paste your key"}
      showLabel={false}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
    />
  );
};
