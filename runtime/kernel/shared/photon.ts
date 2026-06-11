/**
 * Lazy loader for @silvia-odwyer/photon-node (Rust/WASM image processing).
 * Ported from pi-mono's coding-agent photon wrapper, minus the compiled-
 * binary readFileSync patching — Stella's worker always runs from a tree
 * with node_modules present, so the package's own WASM lookup just works.
 */

export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

type PhotonModule = typeof import("@silvia-odwyer/photon-node");

let photonModule: PhotonModule | null = null;
let loadPromise: Promise<PhotonModule | null> | null = null;

export const loadPhoton = async (): Promise<PhotonModule | null> => {
  if (photonModule) {
    return photonModule;
  }
  loadPromise ??= (async () => {
    try {
      photonModule = await import("@silvia-odwyer/photon-node");
      return photonModule;
    } catch {
      photonModule = null;
      return photonModule;
    }
  })();
  return loadPromise;
};
