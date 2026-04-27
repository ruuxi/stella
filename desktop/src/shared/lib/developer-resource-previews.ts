import { useEffect, useState } from "react";

export const DEVELOPER_RESOURCE_PREVIEWS_KEY =
  "stella-developer-resource-previews";

export const DEVELOPER_RESOURCE_PREVIEWS_CHANGED_EVENT =
  "stella:developer-resource-previews-changed";

export const getDeveloperResourcePreviewsEnabled = (): boolean => {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(DEVELOPER_RESOURCE_PREVIEWS_KEY) === "true";
};

export const setDeveloperResourcePreviewsEnabled = (enabled: boolean) => {
  window.localStorage.setItem(
    DEVELOPER_RESOURCE_PREVIEWS_KEY,
    enabled ? "true" : "false",
  );
  window.dispatchEvent(
    new CustomEvent(DEVELOPER_RESOURCE_PREVIEWS_CHANGED_EVENT, {
      detail: { enabled },
    }),
  );
};

export const useDeveloperResourcePreviewsEnabled = (): boolean => {
  const [enabled, setEnabled] = useState(getDeveloperResourcePreviewsEnabled);

  useEffect(() => {
    const sync = () => setEnabled(getDeveloperResourcePreviewsEnabled());
    window.addEventListener("storage", sync);
    window.addEventListener(DEVELOPER_RESOURCE_PREVIEWS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(DEVELOPER_RESOURCE_PREVIEWS_CHANGED_EVENT, sync);
    };
  }, []);

  return enabled;
};
