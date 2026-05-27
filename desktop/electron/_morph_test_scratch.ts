/**
 * Auto-edited by the morph-test app to trigger a full Electron-binary
 * restart self-mod run. `main.ts` imports this file as a side effect so
 * esbuild keeps it in the bundled main process output. Every flag flip
 * changes `dist-electron/desktop/electron/main.js`, which
 * `dev-electron.mjs`'s chokidar watcher picks up via
 * `shouldRestartElectronForBuildPath` and uses to kill + relaunch the
 * Electron process.
 */

export const MORPH_TEST_PROCESS_RESTART_FEATURE_ENABLED = false;

(globalThis as typeof globalThis & {
  __STELLA_MORPH_TEST_PROCESS_RESTART_FEATURE_ENABLED?: boolean;
}).__STELLA_MORPH_TEST_PROCESS_RESTART_FEATURE_ENABLED =
  MORPH_TEST_PROCESS_RESTART_FEATURE_ENABLED;
