// react-grab is used as a headless React-fiber → source-location resolver behind
// Stella's existing area-select overlay. We do NOT use its toolbar, hover label,
// drag-box, success flash, or its ⌘C/Ctrl+C activation key — Stella drives the
// selection ring + click itself and just asks react-grab for the source info on
// commit.

import type { ReactGrabAPI, SourceInfo } from "react-grab";

export type ReactGrabSource = {
  filePath?: string;
  lineNumber?: number;
  componentName?: string;
  stack?: string;
};

type GlobalApiModule = typeof import("react-grab");

let modulePromise: Promise<GlobalApiModule> | null = null;
let apiPromise: Promise<ReactGrabAPI | null> | null = null;

const loadModule = (): Promise<GlobalApiModule> => {
  if (modulePromise) return modulePromise;
  modulePromise = import("react-grab").then((mod) => {
    const api = mod.getGlobalApi();
    if (api) {
      configureApi(api);
    }
    return mod;
  });
  return modulePromise;
};

const configureApi = (api: ReactGrabAPI): void => {
  try {
    api.setEnabled(false);
  } catch {
    // setEnabled may throw if instrumentation isn't fully wired yet; we
    // re-apply via the disable plugin below regardless.
  }
  try {
    api.registerPlugin({
      name: "stella-headless",
      theme: {
        selectionBox: { enabled: false },
        dragBox: { enabled: false },
        grabbedBoxes: { enabled: false },
        elementLabel: { enabled: false },
        toolbar: { enabled: false },
      },
      options: {
        activationMode: "hold",
        activationKey: () => false,
        allowActivationInsideInput: false,
        freezeReactUpdates: false,
      },
    });
  } catch {
    // Already registered; safe to ignore on hot reload.
  }
};

const getApi = (): Promise<ReactGrabAPI | null> => {
  if (apiPromise) return apiPromise;
  apiPromise = loadModule()
    .then((mod) => {
      const api = mod.getGlobalApi();
      if (api) configureApi(api);
      return api ?? null;
    })
    .catch(() => null);
  return apiPromise;
};

export const primeReactGrabSource = (): void => {
  void getApi();
};

export const resolveReactGrabSource = async (
  element: Element,
): Promise<ReactGrabSource | null> => {
  const api = await getApi();
  if (!api) return null;

  let source: SourceInfo | null = null;
  let stack: string | null = null;

  try {
    source = await api.getSource(element);
  } catch {
    source = null;
  }
  try {
    stack = await api.getStackContext(element);
  } catch {
    stack = null;
  }

  if (!source && !stack) return null;

  const result: ReactGrabSource = {};
  if (source?.filePath) result.filePath = source.filePath;
  if (typeof source?.lineNumber === "number") result.lineNumber = source.lineNumber;
  if (source?.componentName) result.componentName = source.componentName;
  if (stack && stack.trim()) result.stack = stack.trim();

  return Object.keys(result).length > 0 ? result : null;
};
