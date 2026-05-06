import { contextBridge, ipcRenderer, webUtils } from "electron";

const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>;

contextBridge.exposeInMainWorld("stellaDesktopStore", {
  getAuthToken: () => invoke<string | null>("storeWeb:getAuthToken"),
  readFeatureSnapshot: () => invoke("storeWeb:readFeatureSnapshot"),
  listInstalledMods: () => invoke("storeWeb:listInstalledMods"),
  getRelease: (payload: { packageId: string; releaseNumber: number }) =>
    invoke("storeWeb:getRelease", payload),
  installFromBlueprint: (payload: {
    packageId: string;
    releaseNumber: number;
    displayName: string;
    blueprintMarkdown: string;
    commits?: Array<{ hash: string; subject: string; diff: string }>;
  }) => invoke("storeWeb:installFromBlueprint", payload),
  uninstallPackage: (packageId: string) =>
    invoke("storeWeb:uninstallMod", { packageId }),
  getThread: () => invoke("storeWeb:getThread"),
  sendThreadMessage: (payload: {
    text: string;
    attachedFeatureNames?: string[];
    editingBlueprint?: boolean;
  }) => invoke("storeWeb:sendThreadMessage", payload),
  cancelThreadTurn: () => invoke("storeWeb:cancelThreadTurn"),
  denyLatestBlueprint: () => invoke("storeWeb:denyLatestBlueprint"),
  markBlueprintPublished: (payload: {
    messageId: string;
    releaseNumber: number;
  }) => invoke("storeWeb:markBlueprintPublished", payload),
  publishBlueprint: (payload: {
    messageId: string;
    packageId: string;
    asUpdate: boolean;
    displayName?: string;
    description?: string;
    category?: string;
    manifest: Record<string, unknown>;
    releaseNotes?: string;
  }) => invoke("storeWeb:publishBlueprint", payload),
  openStorePanel: () => invoke("storeWeb:openStorePanel"),
  listConnectors: () => invoke("storeWeb:listConnectors"),
  installConnector: (
    marketplaceKey: string,
    credential?: string,
    config?: Record<string, string>,
  ) =>
    invoke("storeWeb:installConnector", {
      marketplaceKey,
      credential,
      config,
    }),
  installPet: (payload: {
    pet: {
      id: string;
      displayName: string;
      description: string;
      kind: string;
      tags: string[];
      ownerName: string | null;
      spritesheetUrl: string;
      previewUrl?: string;
      sourceUrl?: string;
      downloads?: number;
    };
  }) => invoke("storeWeb:installPet", payload),
  selectPet: (payload: { petId: string }) => invoke("storeWeb:selectPet", payload),
  removePet: (payload: { petId: string }) => invoke("storeWeb:removePet", payload),
  getPetState: () => invoke("storeWeb:getPetState"),
  setPetOpen: (payload: { open: boolean }) => invoke("storeWeb:setPetOpen", payload),
  installEmojiPack: (payload: { packId: string; sheetUrls: string[] }) =>
    invoke("storeWeb:installEmojiPack", payload),
  clearEmojiPack: (payload?: { packId?: string }) =>
    invoke("storeWeb:clearEmojiPack", payload),
  getEmojiPackState: () => invoke("storeWeb:getEmojiPackState"),
  fashion: {
    pickAndSaveBodyPhoto: () =>
      invoke("storeWeb:fashionLocalAction", {
        action: "pickAndSaveBodyPhoto",
      }),
    getBodyPhotoInfo: () =>
      invoke("storeWeb:fashionLocalAction", { action: "getBodyPhotoInfo" }),
    getBodyPhotoDataUrl: () =>
      invoke("storeWeb:fashionLocalAction", { action: "getBodyPhotoDataUrl" }),
    getLocalImageDataUrl: (path: string) =>
      invoke("storeWeb:fashionLocalAction", {
        action: "getLocalImageDataUrl",
        payload: { path },
      }),
    pickTryOnImages: () =>
      invoke("storeWeb:fashionLocalAction", { action: "pickTryOnImages" }),
    getDroppedFilePath: (file: File) => {
      try {
        return webUtils.getPathForFile(file) || "";
      } catch {
        return "";
      }
    },
    startOutfitBatch: (payload: {
      prompt?: string;
      batchId?: string;
      count?: number;
      excludeProductIds?: string[];
      seedHints?: string[];
    }) =>
      invoke("storeWeb:fashionLocalAction", {
        action: "startOutfitBatch",
        payload,
      }),
    startTryOn: (payload: {
      prompt?: string;
      batchId?: string;
      imagePaths?: string[];
      imageUrls?: string[];
    }) =>
      invoke("storeWeb:fashionLocalAction", {
        action: "startTryOn",
        payload,
      }),
  },
});
