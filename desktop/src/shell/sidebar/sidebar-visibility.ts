export const SIDEBAR_VISIBILITY_STORAGE_KEY = "stella:sidebar:visible";

export const readPersistedSidebarVisible = (): boolean => {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SIDEBAR_VISIBILITY_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
};

export const writePersistedSidebarVisible = (visible: boolean) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_VISIBILITY_STORAGE_KEY, visible ? "1" : "0");
  } catch {
    // localStorage can throw in private mode; visibility is cosmetic only.
  }
};

export const syncSidebarHiddenDataset = (visible: boolean) => {
  const root = document.documentElement;
  if (visible) delete root.dataset.sidebarHidden;
  else root.dataset.sidebarHidden = "true";
};
