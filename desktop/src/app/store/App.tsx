import { useEffect } from "react";
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
});

const getEmojiPackState = () => ({
  activePack: readActiveEmojiPack(),
});

const normalizeActionRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const handleStoreWebLocalAction = async (action: unknown): Promise<unknown> => {
  const record = normalizeActionRecord(action);
  const type = record.type;
  const payload = normalizeActionRecord(record.payload);

  switch (type) {
    case "openStorePanel": {
      openStoreDisplayTab();
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
    default:
      throw new Error("Unknown Store bridge action.");
  }
};

export function StoreApp() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/store" });

  const requestedTab = normalizeStoreTab(search.tab);
  const urlIsLegacy = typeof search.tab === "string" && search.tab !== requestedTab;

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
    void window.electronAPI?.storeWeb?.show({
      tab: requestedTab,
      package:
        typeof search.package === "string" && search.package.trim()
          ? search.package
          : undefined,
    });
    return () => {
      void window.electronAPI?.storeWeb?.hide();
    };
  }, [requestedTab, search.package]);

  useEffect(() => {
    return window.electronAPI?.storeWebLocal?.onAction?.((payload) => {
      void handleStoreWebLocalAction(payload.action)
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
  }, []);

  return (
    <div className="workspace-area">
      <div className="workspace-content workspace-content--full" />
    </div>
  );
}
