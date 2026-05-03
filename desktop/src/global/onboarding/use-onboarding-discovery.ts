import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import {
  BROWSER_PROFILE_KEY,
  BROWSER_SELECTION_KEY,
  DISCOVERY_CATEGORIES_CHANGED_EVENT,
  DISCOVERY_CATEGORIES_KEY,
  type DiscoveryCategory,
} from "@/shared/contracts/discovery";
import {
  BROWSERS,
  DISCOVERY_CATEGORIES,
  type BrowserId,
  type Phase,
} from "./onboarding-flow";

type CategoryStates = Record<DiscoveryCategory, boolean>;

type UseOnboardingDiscoveryArgs = {
  isAuthenticated?: boolean;
  onDiscoveryConfirm?: (categories: DiscoveryCategory[]) => void;
  onSelectionChange?: (hasSelections: boolean) => void;
  phase: Phase;
  nextSplitStep: () => void;
};

const createDiscoveryCategoryStates = (): CategoryStates => {
  const initial = {} as CategoryStates;
  for (const category of DISCOVERY_CATEGORIES) {
    initial[category.id] = category.defaultEnabled;
  }
  return initial;
};

const getSelectedDiscoveryCategories = (states: CategoryStates) =>
  DISCOVERY_CATEGORIES.filter((category) => states[category.id]).map(
    (category) => category.id,
  );

const getFirstEnabledDiscoveryCategory = (states: CategoryStates) =>
  DISCOVERY_CATEGORIES.find((category) => states[category.id])?.id ?? null;

export function useOnboardingDiscovery({
  isAuthenticated,
  onDiscoveryConfirm,
  onSelectionChange,
  phase,
  nextSplitStep,
}: UseOnboardingDiscoveryArgs) {
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [selectedBrowser, setSelectedBrowser] = useState<BrowserId | null>(
    null,
  );
  const [detectedBrowser, setDetectedBrowser] = useState<BrowserId | null>(
    null,
  );
  const [availableProfiles, setAvailableProfiles] = useState<
    { id: string; name: string }[]
  >([]);
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [showNoneWarning, setShowNoneWarning] = useState(false);
  const [activeMockId, setActiveMockId] = useState<string | null>(null);
  const [categoryStates, setCategoryStates] = useState<CategoryStates>(
    createDiscoveryCategoryStates,
  );

  const savePreferredBrowser = useMutation(
    api.data.preferences.setPreferredBrowser,
  );

  useEffect(() => {
    // Only signal selection state while we're actually on the browser
    // phase. Previously this fired on every category-toggle change (and
    // on every mount) regardless of phase, which spammed the parent's
    // `setHasDiscoverySelections` setter and caused the overlay tree to
    // re-render through `useOnboardingOverlay` for unrelated phases.
    if (phase !== "browser") {
      // Leaving the browser phase: reset the elevated-creature flag so
      // Stella glides back to its parked split position instead of
      // staying lifted into the now-empty mock slot above the next
      // phase's copy.
      onSelectionChange?.(false);
      return;
    }
    const hasAny =
      Object.values(categoryStates).some((value) => value) || browserEnabled;
    onSelectionChange?.(hasAny);
  }, [browserEnabled, categoryStates, onSelectionChange, phase]);

  useEffect(() => {
    if (!browserEnabled || detectedBrowser) {
      return;
    }

    let cancelled = false;

    const detectBrowser = async () => {
      try {
        const detected =
          await window.electronAPI?.discovery.detectPreferred?.();
        if (cancelled || !detected?.browser) {
          return;
        }

        const supportedBrowserIds = new Set(
          BROWSERS.map((browser) => browser.id),
        );
        const detectedId = detected.browser as BrowserId;
        if (!supportedBrowserIds.has(detectedId)) {
          return;
        }

        setDetectedBrowser(detectedId);
        setSelectedBrowser(detectedId);
      } catch {
        // Detection is best-effort only.
      }
    };

    void detectBrowser();

    return () => {
      cancelled = true;
    };
  }, [browserEnabled, detectedBrowser]);

  useEffect(() => {
    if (!selectedBrowser) {
      return;
    }

    let cancelled = false;

    const loadProfiles = async () => {
      try {
        const profiles =
          await window.electronAPI?.discovery.listProfiles?.(selectedBrowser);
        if (!cancelled && profiles) {
          setAvailableProfiles(profiles);
          setSelectedProfile((currentProfile) => {
            if (
              currentProfile &&
              profiles.some((profile) => profile.id === currentProfile)
            ) {
              return currentProfile;
            }
            return profiles.length > 0 ? profiles[0].id : null;
          });
        }
      } catch {
        if (!cancelled) {
          setAvailableProfiles([]);
          setSelectedProfile(null);
        }
      }
    };

    void loadProfiles();

    return () => {
      cancelled = true;
    };
  }, [selectedBrowser]);

  const confirmDiscovery = useCallback(() => {
    const selected = getSelectedDiscoveryCategories(categoryStates);
    const nothingSelected = selected.length === 0 && !browserEnabled;

    if (nothingSelected && !showNoneWarning) {
      setShowNoneWarning(true);
      return;
    }

    localStorage.setItem(DISCOVERY_CATEGORIES_KEY, JSON.stringify(selected));
    window.dispatchEvent(new Event(DISCOVERY_CATEGORIES_CHANGED_EVENT));

    if (browserEnabled && selectedBrowser) {
      localStorage.setItem(BROWSER_SELECTION_KEY, selectedBrowser);
      if (selectedProfile) {
        localStorage.setItem(BROWSER_PROFILE_KEY, selectedProfile);
      } else {
        localStorage.removeItem(BROWSER_PROFILE_KEY);
      }
    } else {
      localStorage.removeItem(BROWSER_SELECTION_KEY);
      localStorage.removeItem(BROWSER_PROFILE_KEY);
    }

    if (isAuthenticated) {
      const preferredBrowser =
        browserEnabled && selectedBrowser ? selectedBrowser : "none";
      void savePreferredBrowser({
        browser: preferredBrowser,
      }).catch(() => {
        // Browser preference sync is best-effort only.
      });
    }

    onDiscoveryConfirm?.(selected);
    nextSplitStep();
  }, [
    browserEnabled,
    categoryStates,
    isAuthenticated,
    nextSplitStep,
    onDiscoveryConfirm,
    savePreferredBrowser,
    selectedBrowser,
    selectedProfile,
    showNoneWarning,
  ]);

  const toggleCategory = useCallback(
    (id: DiscoveryCategory) => {
      const wasEnabled = categoryStates[id];
      const nextCategoryStates = { ...categoryStates, [id]: !wasEnabled };
      setCategoryStates(nextCategoryStates);
      setShowNoneWarning(false);

      if (!wasEnabled) {
        setActiveMockId(id);
      } else if (activeMockId === id) {
        setActiveMockId(
          browserEnabled
            ? "browser"
            : getFirstEnabledDiscoveryCategory(nextCategoryStates),
        );
      }
    },
    [activeMockId, browserEnabled, categoryStates],
  );

  const toggleBrowser = useCallback(() => {
    const wasEnabled = browserEnabled;
    setBrowserEnabled((current) => !current);
    setShowNoneWarning(false);

    if (wasEnabled) {
      setSelectedBrowser(null);
      setDetectedBrowser(null);
      setAvailableProfiles([]);
      setSelectedProfile(null);
      if (activeMockId === "browser") {
        setActiveMockId(getFirstEnabledDiscoveryCategory(categoryStates));
      }
      return;
    }

    setActiveMockId("browser");
  }, [activeMockId, browserEnabled, categoryStates]);

  const selectBrowser = useCallback((browserId: BrowserId) => {
    setAvailableProfiles([]);
    setSelectedProfile(null);
    setSelectedBrowser(browserId);
  }, []);

  return {
    activeMockId,
    availableProfiles,
    browserEnabled,
    categoryStates,
    selectedBrowser,
    selectedProfile,
    showNoneWarning,
    confirmDiscovery,
    selectBrowser,
    setSelectedProfile,
    toggleBrowser,
    toggleCategory,
  };
}
