// This virtual module is provided by @vitejs/plugin-react during Vite dev.
// It must execute before any React renderer modules in bundled dev mode.
// @ts-expect-error Vite virtual module
import { injectIntoGlobalHook } from "/@react-refresh";

type RefreshWindow = Window &
  typeof globalThis & {
    __stellaReactRefreshPreambleInstalled__?: boolean;
    $RefreshReg$?: () => void;
    $RefreshSig$?: () => <T>(type: T) => T;
  };

if (import.meta.hot && __STELLA_BUNDLED_DEV__) {
  const refreshWindow = window as RefreshWindow;
  if (!refreshWindow.__stellaReactRefreshPreambleInstalled__) {
    injectIntoGlobalHook(window);
    refreshWindow.$RefreshReg$ = () => {};
    refreshWindow.$RefreshSig$ = () => (type) => type;
    refreshWindow.__stellaReactRefreshPreambleInstalled__ = true;
  }
}
