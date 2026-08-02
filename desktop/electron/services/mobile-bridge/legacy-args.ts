import {
  IPC_PAYLOAD_CONTRACT,
  type IpcPayloadContract,
} from "./ipc-payload-contract.generated.js";

/**
 * Argument-shape compatibility for phone builds that pack their own payloads.
 *
 * `window.electronAPI` on the desktop is the preload (`electron/preload.ts`);
 * on the phone it is a shim injected into the WebView. Several preload methods
 * take positional arguments but pack them into a single payload object before
 * `ipcRenderer.invoke`, and the `ipcMain.handle` handlers are written against
 * that packed shape. A shim that forwarded its arguments positionally arrived
 * as `(event, url, init)` where the handler destructured `payload.url` —
 * yielding `undefined` and, for `browser:fetchJson`, the user-visible
 * "Cannot read properties of undefined (reading 'trim')".
 *
 * Current phones read the packed shape from the capability manifest, so they
 * send it correctly. This repacks for the ones that do not: phone releases ship
 * through the App Store and lag the desktop, so a desktop update alone repairs
 * already-installed phones. It is a no-op once the packed object arrives.
 *
 * The shapes come from the generated contract rather than a hand-written list,
 * so a channel added or reshaped in preload is covered without touching this
 * file.
 */

const objectContract = (
  channel: string,
): Extract<IpcPayloadContract, { kind: "object" }> | null => {
  const contract = IPC_PAYLOAD_CONTRACT[channel];
  return contract?.kind === "object" ? contract : null;
};

/**
 * Repacks legacy positional arguments into the single payload object the
 * handler expects. Returns `args` untouched when the phone already sent the
 * packed object, when the channel does not take one, or when the call carries
 * no arguments at all.
 */
export const adaptLegacyMobileArgs = (
  channel: string,
  args: unknown[],
): unknown[] => {
  const contract = objectContract(channel);
  if (!contract || args.length === 0) return args;

  // A single plain object is taken as an already-packed payload and passed
  // through. Repacking it positionally would turn a correct payload into
  // `{ firstField: <the whole payload> }`, and a payload that is wrong in some
  // other way — misspelled field names, say — is not something positional
  // repacking could fix anyway. Only genuinely positional calls are repacked.
  const [first] = args;
  if (
    args.length === 1 &&
    typeof first === "object" &&
    first !== null &&
    !Array.isArray(first)
  ) {
    return args;
  }

  // These two APIs gained grouped-card fields ahead of their legacy scalar
  // selectors. Old App Store builds still call `(commitHash)` and
  // `(commitHash, steps)` positionally, so generic field-order packing would
  // misread the hash as `applyId`. Current phones send an object and return
  // through the branch above.
  if (channel === "selfmod:apply") {
    return [{ ...(first !== undefined ? { commitHash: first } : {}) }];
  }
  if (channel === "selfmod:revert") {
    return [
      {
        ...(first !== undefined ? { commitHash: first } : {}),
        ...(args[1] !== undefined ? { steps: args[1] } : {}),
      },
    ];
  }

  const payload: Record<string, unknown> = {};
  contract.fields.forEach((field, index) => {
    if (index < args.length && args[index] !== undefined) {
      payload[field] = args[index];
    }
  });
  return [payload];
};
