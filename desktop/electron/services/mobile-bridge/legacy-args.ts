/**
 * Argument-shape compatibility for older phone builds.
 *
 * `window.electronAPI` on the desktop is the preload (`desktop/electron/preload.ts`);
 * on the phone it is a hand-written shim injected into the WebView. Several
 * preload methods take positional arguments but pack them into a single payload
 * object before `ipcRenderer.invoke`, and the `ipcMain.handle` handlers are
 * written against that packed shape. Shim methods that forwarded their
 * arguments positionally therefore arrived as `(event, url, init)` where the
 * handler destructured `payload.url` — yielding `undefined` and, for
 * `browser:fetchJson`, the user-visible
 * "Cannot read properties of undefined (reading 'trim')".
 *
 * The shim now packs these correctly, but phone releases ship through the App
 * Store and lag the desktop. Normalizing here means a desktop update alone
 * repairs already-installed phones, and it is a no-op once the phone sends the
 * packed object.
 */

/**
 * Positional parameter names, in order, for channels that expect one object.
 *
 * This also covers paths the shim never defines by hand: capabilities absent
 * from the shim are auto-installed from the manifest by `installRemoteCapabilities`,
 * which always forwards positionally. Those can only be corrected here.
 */
const LEGACY_POSITIONAL_ARGS: Record<string, readonly string[]> = {
  "browser:fetchJson": ["url", "init"],
  "browser:fetchText": ["url", "init"],
  "media:saveOutput": ["url", "fileName", "kind"],
  "llmCredentials:delete": ["provider"],
  // Auto-installed from the capability manifest, so always positional.
  "selfmod:apply": ["commitHash"],
  "selfmod:recentCommits": ["limit"],
  "llmCredentials:loginOAuth": ["provider"],
  "llmCredentials:deleteOAuth": ["provider"],
};

/**
 * Repacks legacy positional arguments into the single payload object the
 * handler expects. Returns `args` untouched when the phone already sent the
 * packed object, when the channel has no known legacy shape, or when the call
 * carries no arguments at all.
 */
export const adaptLegacyMobileArgs = (
  channel: string,
  args: unknown[],
): unknown[] => {
  const parameterNames = LEGACY_POSITIONAL_ARGS[channel];
  if (!parameterNames || args.length === 0) return args;

  // Already packed: a single plain object carrying at least the first field.
  const [first] = args;
  if (
    args.length === 1 &&
    typeof first === "object" &&
    first !== null &&
    !Array.isArray(first) &&
    parameterNames[0] in first
  ) {
    return args;
  }

  const payload: Record<string, unknown> = {};
  parameterNames.forEach((name, index) => {
    if (index < args.length && args[index] !== undefined) {
      payload[name] = args[index];
    }
  });
  return [payload];
};
