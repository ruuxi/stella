/**
 * Binary values in the JSON IPC lane (`POST /bridge/ipc/:channel`, `/bridge/ws`).
 *
 * Electron's own IPC uses structured clone, so handlers return `Uint8Array`
 * directly (e.g. `display:readFile` returns raw file bytes). The mobile bridge
 * re-serializes those results with `JSON.stringify`, which turns a typed array
 * into a numeric-keyed object — `{"0":137,"1":80,…}`. The phone then receives a
 * plain object where the desktop renderer expects a `Uint8Array`, so calls like
 * `new TextDecoder().decode(bytes)` throw and apps fall back to an empty state.
 * It is also ~8-10x the wire size of the bytes themselves.
 *
 * Binary payloads are therefore tagged and base64-encoded (~1.33x) on the way
 * out and rehydrated by the phone's shim. The dedicated `/bridge/file` lane is
 * still the efficient path for whole-file downloads, but it requires an
 * encrypted session and only carries `display:readFile`; this codec keeps every
 * other binary-returning channel correct.
 *
 * Wire shape (duplicated in the mobile shim — keep both sides in sync):
 *   { "__stellaBridgeBinary": "base64", "data": "<base64>", "byteLength": <n> }
 */

export const BRIDGE_BINARY_TAG = "__stellaBridgeBinary";

/** Objects/arrays deeper than this are passed through untouched. */
const MAX_DEPTH = 8;

const toBase64 = (view: Uint8Array): string =>
  Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");

const encodeView = (view: Uint8Array) => ({
  [BRIDGE_BINARY_TAG]: "base64" as const,
  data: toBase64(view),
  byteLength: view.byteLength,
});

/**
 * Deep-copies `value`, replacing binary payloads with tagged base64 envelopes.
 *
 * Only plain objects and arrays are traversed; class instances and other exotic
 * values are returned as-is, matching what `JSON.stringify` would have done.
 */
export const encodeBridgeBinaryValues = (
  value: unknown,
  depth = 0,
): unknown => {
  if (value instanceof Uint8Array) return encodeView(value);
  if (value instanceof ArrayBuffer) return encodeView(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return encodeView(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }

  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const encoded = encodeBridgeBinaryValues(entry, depth + 1);
      if (encoded !== entry) changed = true;
      return encoded;
    });
    return changed ? next : value;
  }

  // Leave class instances (Date, Map, …) alone; JSON.stringify already has
  // established behaviour for them and rewriting could change the contract.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const encoded = encodeBridgeBinaryValues(entry, depth + 1);
    if (encoded !== entry) changed = true;
    next[key] = encoded;
  }
  return changed ? next : value;
};
