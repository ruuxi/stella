import { useCallback, useEffect, useRef } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  DEFAULT_STORE_TAB,
  normalizeStoreTab,
  type StoreTab,
} from "@/global/store/store-tabs";
import { openStoreDisplayTab } from "@/shell/display/default-tabs";
import {
  addInstalledPet,
  readInstalledPetIds,
  removeInstalledPet,
} from "@/app/pets/installed-pets";
import {
  readPetOpenPreference,
  readSelectedPetId,
  writePetOpenPreference,
  writeSelectedPetId,
} from "@/shell/pet/pet-preferences";
import {
  readActiveEmojiPack,
  writeActiveEmojiPack,
} from "@/app/chat/emoji-sprites/active-emoji-pack";
import { writeCachedPetById } from "@/shell/pet/pet-catalog-cache";
import { normalizePet } from "@/shell/pet/built-in-pets";
import { useDisplayPanelLayout } from "@/shell/display/tab-store";
import { useEmbeddedWebsiteTheme } from "@/global/website-view/use-embedded-website-theme";
import { EmbeddedWebsiteGlassPlaceholder } from "@/global/website-view/EmbeddedWebsiteGlassPlaceholder";
import { useNativeWebsiteGlassSuspension } from "@/shared/lib/native-website-overlay";

// Persist the last-active Store tab so clicking the global sidebar's Store
// icon reopens to wherever the user was last (Discover by default). The URL
// query param is still the source of truth while inside Store; this only
// fires when no `?tab=` is present on entry.
const LAST_STORE_TAB_KEY = "stella.store.lastTab";

const readStoredTab = (): StoreTab => {
  try {
    const raw = window.localStorage?.getItem(LAST_STORE_TAB_KEY);
    return normalizeStoreTab(raw);
  } catch {
    return DEFAULT_STORE_TAB;
  }
};

const getPetState = () => ({
  installedPetIds: Array.from(readInstalledPetIds()),
  selectedPetId: readSelectedPetId(),
  petOpen: readPetOpenPreference(),
});

const getEmojiPackState = () => ({
  activePack: readActiveEmojiPack(),
});

const normalizeActionRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
};

const approvedStoreWebTryOnImagePaths = new Set<string>();

const rememberApprovedTryOnImagePaths = (value: unknown) => {
  const record = normalizeActionRecord(value);
  const paths = normalizeStringArray(record.paths);
  if (!paths) return;
  for (const imagePath of paths) {
    approvedStoreWebTryOnImagePaths.add(imagePath);
  }
};

const filterApprovedTryOnImagePaths = (value: unknown): string[] | undefined => {
  const paths = normalizeStringArray(value);
  if (!paths) return undefined;
  const approved = paths.filter((imagePath) =>
    approvedStoreWebTryOnImagePaths.has(imagePath),
  );
  if (approved.length !== paths.length) {
    throw new Error("Choose local try-on images from Stella before using them.");
  }
  return approved.length > 0 ? approved : undefined;
};

type StoreWebLocalActionHandlers = {
  openSignIn: () => void;
};

const handleStoreWebLocalAction = async (
  action: unknown,
  handlers: StoreWebLocalActionHandlers,
): Promise<unknown> => {
  const record = normalizeActionRecord(action);
  const type = record.type;
  const payload = normalizeActionRecord(record.payload);
  const fashion = window.electronAPI?.fashion;

  switch (type) {
    case "openStorePanel": {
      openStoreDisplayTab();
      return { ok: true };
    }
    case "openSignIn": {
      handlers.openSignIn();
      return { ok: true };
    }
    case "installPet": {
      const pet = normalizePet(
        normalizeActionRecord(payload.pet) as Parameters<typeof normalizePet>[0],
      );
      if (!pet) throw new Error("Invalid pet payload.");
      writeCachedPetById(pet);
      addInstalledPet(pet.id);
      writeSelectedPetId(pet.id);
      writePetOpenPreference(true);
      window.electronAPI?.pet?.setOpen?.(true);
      return getPetState();
    }
    case "selectPet": {
      const petId = typeof payload.petId === "string" ? payload.petId : "";
      if (!petId) throw new Error("Missing pet id.");
      writeSelectedPetId(petId);
      writePetOpenPreference(true);
      window.electronAPI?.pet?.setOpen?.(true);
      return getPetState();
    }
    case "removePet": {
      const petId = typeof payload.petId === "string" ? payload.petId : "";
      if (!petId) throw new Error("Missing pet id.");
      removeInstalledPet(petId);
      return getPetState();
    }
    case "getPetState":
      return getPetState();
    case "setPetOpen": {
      const open = Boolean(payload.open);
      writePetOpenPreference(open);
      window.electronAPI?.pet?.setOpen?.(open);
      return getPetState();
    }
    case "installEmojiPack": {
      const packId = typeof payload.packId === "string" ? payload.packId : "";
      const sheetUrls = Array.isArray(payload.sheetUrls)
        ? payload.sheetUrls.filter((url): url is string => typeof url === "string")
        : [];
      if (!packId || sheetUrls.length === 0) {
        throw new Error("Invalid emoji pack payload.");
      }
      writeActiveEmojiPack({ packId, sheetUrls });
      return getEmojiPackState();
    }
    case "clearEmojiPack": {
      const packId = typeof payload.packId === "string" ? payload.packId : null;
      const active = readActiveEmojiPack();
      if (!packId || active?.packId === packId) {
        writeActiveEmojiPack(null);
      }
      return getEmojiPackState();
    }
    case "getEmojiPackState":
      return getEmojiPackState();
    case "fashion": {
      const innerAction = payload.action;
      const innerPayload = normalizeActionRecord(payload.payload);
      switch (innerAction) {
        case "pickAndSaveBodyPhoto":
          return await fashion?.pickAndSaveBodyPhoto?.();
        case "getBodyPhotoInfo":
          return await fashion?.getBodyPhotoInfo?.();
        case "getBodyPhotoDataUrl":
          return await fashion?.getBodyPhotoDataUrl?.();
        case "getLocalImageDataUrl": {
          const imagePath =
            typeof innerPayload.path === "string" ? innerPayload.path : "";
          if (!imagePath) throw new Error("Missing image path.");
          return await fashion?.getLocalImageDataUrl?.(imagePath);
        }
        case "pickTryOnImages": {
          const result = await fashion?.pickTryOnImages?.();
          rememberApprovedTryOnImagePaths(result);
          return result;
        }
        case "startOutfitBatch":
          return await fashion?.startOutfitBatch?.({
            ...(typeof innerPayload.prompt === "string"
              ? { prompt: innerPayload.prompt }
              : {}),
            ...(typeof innerPayload.batchId === "string"
              ? { batchId: innerPayload.batchId }
              : {}),
            ...(typeof innerPayload.count === "number"
              ? { count: innerPayload.count }
              : {}),
            ...(normalizeStringArray(innerPayload.excludeProductIds)
              ? {
                  excludeProductIds: normalizeStringArray(
                    innerPayload.excludeProductIds,
                  ),
                }
              : {}),
            ...(normalizeStringArray(innerPayload.seedHints)
              ? { seedHints: normalizeStringArray(innerPayload.seedHints) }
              : {}),
          });
        case "startTryOn": {
          const approvedImagePaths = filterApprovedTryOnImagePaths(
            innerPayload.imagePaths,
          );
          return await fashion?.startTryOn?.({
            ...(typeof innerPayload.prompt === "string"
              ? { prompt: innerPayload.prompt }
              : {}),
            ...(typeof innerPayload.batchId === "string"
              ? { batchId: innerPayload.batchId }
              : {}),
            ...(approvedImagePaths ? { imagePaths: approvedImagePaths } : {}),
            ...(normalizeStringArray(innerPayload.imageUrls)
              ? { imageUrls: normalizeStringArray(innerPayload.imageUrls) }
              : {}),
          });
        }
        default:
          throw new Error("Unknown Store Fashion bridge action.");
      }
    }
    default:
      throw new Error("Unknown Store bridge action.");
  }
};

export function StoreApp() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/store" });
  const { panelOpen, panelExpanded, panelWidth } = useDisplayPanelLayout();
  const layoutFrameRef = useRef<number | null>(null);
  const embeddedTheme = useEmbeddedWebsiteTheme();
  const {
    viewSuspended,
    placeholderVisible,
    placeholderActive,
  } = useNativeWebsiteGlassSuspension();

  const requestedTab = normalizeStoreTab(search.tab);
  const urlIsLegacy = typeof search.tab === "string" && search.tab !== requestedTab;

  const syncStoreWebLayout = useCallback(() => {
    const contentArea = document.querySelector<HTMLElement>(".content-area");
    if (!contentArea) return;
    const rect = contentArea.getBoundingClientRect();
    const styles = window.getComputedStyle(contentArea);
    const topInset = Number.parseFloat(styles.paddingTop) || 0;
    void window.electronAPI?.storeWeb?.setLayout?.({
      x: Math.round(rect.left),
      y: Math.round(rect.top + topInset),
      width:
        viewSuspended || (panelOpen && panelExpanded) ? 0 : Math.round(rect.width),
      height: viewSuspended
        ? 0
        : Math.max(0, Math.round(rect.height - topInset)),
    });
  }, [panelExpanded, panelOpen, viewSuspended]);

  const openSignIn = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown> | undefined) => ({
        ...(prev ?? {}),
        dialog: "auth" as const,
      }),
    });
  }, [navigate]);

  const scheduleStoreWebLayout = useCallback(() => {
    if (layoutFrameRef.current !== null) return;
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = null;
      syncStoreWebLayout();
    });
  }, [syncStoreWebLayout]);

  useEffect(() => {
    scheduleStoreWebLayout();
    const contentArea = document.querySelector<HTMLElement>(".content-area");
    const displaySidebar =
      document.querySelector<HTMLElement>(".display-sidebar");
    const resizeObserver = new ResizeObserver(scheduleStoreWebLayout);
    if (contentArea) resizeObserver.observe(contentArea);
    if (displaySidebar) resizeObserver.observe(displaySidebar);
    window.addEventListener("resize", scheduleStoreWebLayout);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleStoreWebLayout);
      if (layoutFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutFrameRef.current);
        layoutFrameRef.current = null;
      }
    };
  }, [panelExpanded, panelOpen, panelWidth, scheduleStoreWebLayout, viewSuspended]);

  // Two redirects share this effect:
  //   - Legacy `?tab=installed`/`?tab=publish` URLs collapse to Discover.
  //   - First entry without any tab param goes to the user's last-saved tab.
  useEffect(() => {
    if (urlIsLegacy) {
      void navigate({
        to: "/store",
        search: { tab: requestedTab },
        replace: true,
      });
      return;
    }
    if (search.tab) return;
    const stored = readStoredTab();
    if (stored === DEFAULT_STORE_TAB) return;
    void navigate({ to: "/store", search: { tab: stored }, replace: true });
  }, [navigate, search.tab, urlIsLegacy, requestedTab]);

  useEffect(() => {
    try {
      window.localStorage?.setItem(LAST_STORE_TAB_KEY, requestedTab);
    } catch {
      // ignore storage failures
    }
  }, [requestedTab]);

  useEffect(() => {
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      syncStoreWebLayout();
      void window.electronAPI?.storeWeb?.show({
        route: "store",
        tab: requestedTab,
        package:
          typeof search.package === "string" && search.package.trim()
            ? search.package
            : undefined,
        embedded: true,
        theme: embeddedTheme,
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      void window.electronAPI?.storeWeb?.hide();
    };
    // `embeddedTheme` intentionally omitted: live theme updates flow
    // through `useEmbeddedWebsiteTheme`'s own `setTheme` IPC, so we don't
    // re-issue `show()` (which can race the route navigation) every time
    // the user previews a theme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTab, search.package, syncStoreWebLayout]);

  useEffect(() => {
    return window.electronAPI?.storeWebLocal?.onAction?.((payload) => {
      void handleStoreWebLocalAction(payload.action, { openSignIn })
        .then((result) => {
          window.electronAPI?.storeWebLocal?.reply({
            requestId: payload.requestId,
            ok: true,
            result,
          });
        })
        .catch((error) => {
          window.electronAPI?.storeWebLocal?.reply({
            requestId: payload.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
  }, [openSignIn]);

  return (
    <div className="workspace-area">
      <div className="workspace-content workspace-content--full">
        <EmbeddedWebsiteGlassPlaceholder
          visible={placeholderVisible}
          active={placeholderActive}
          surfaceLabel="Store"
        />
      </div>
    </div>
  );
}
