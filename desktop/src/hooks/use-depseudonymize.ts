import { useState, useEffect, useCallback } from "react";

type Replacement = { pattern: RegExp; replacement: string };
type DiscoveryCategory = "browsing_bookmarks" | "dev_environment" | "apps_system" | "messages_notes";

const DISCOVERY_CATEGORIES_KEY = "stella-discovery-categories";

function isMessagesNotesEnabled(): boolean {
  try {
    const raw = localStorage.getItem(DISCOVERY_CATEGORIES_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.includes("messages_notes" satisfies DiscoveryCategory);
  } catch {
    return false;
  }
}

// Module-level cache — survives component remounts, loaded once per session
let cachedReplacements: Replacement[] | null = null;
let loadPromise: Promise<Replacement[]> | null = null;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadReplacements(): Promise<Replacement[]> {
  if (cachedReplacements) return cachedReplacements;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      // Depseudonymize only when Messages & Notes discovery category is enabled.
      if (!isMessagesNotesEnabled()) {
        cachedReplacements = [];
        return [];
      }

      const map = await window.electronAPI?.getIdentityMap?.();
      if (!map?.mappings?.length) {
        cachedReplacements = [];
        return [];
      }

      const pairs: { alias: string; real: string }[] = [];
      for (const m of map.mappings) {
        if (m.alias.name && m.real.name) {
          pairs.push({ alias: m.alias.name, real: m.real.name });
        }
        if (m.alias.identifier && m.real.identifier) {
          pairs.push({ alias: m.alias.identifier, real: m.real.identifier });
        }
      }

      // Sort by alias length desc to avoid partial replacements
      pairs.sort((a, b) => b.alias.length - a.alias.length);

      cachedReplacements = pairs.map(({ alias, real }) => ({
        pattern: new RegExp(`\\b${escapeRegex(alias)}\\b`, "g"),
        replacement: real,
      }));
      return cachedReplacements;
    } catch {
      cachedReplacements = [];
      return [];
    }
  })();

  return loadPromise;
}

function applyReplacements(
  text: string,
  replacements: Replacement[],
): string {
  if (!replacements.length || !text) return text;
  let result = text;
  for (const { pattern, replacement } of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Hook that provides a synchronous depseudonymize function.
 * Loads the identity map once via IPC, then performs client-side
 * string replacement (alias → real) for all subsequent calls.
 * Returns a no-op passthrough if no identity map exists.
 */
export function useDepseudonymize(): (text: string) => string {
  const [replacements, setReplacements] = useState<Replacement[]>(
    cachedReplacements ?? [],
  );

  useEffect(() => {
    if (!isMessagesNotesEnabled()) {
      cachedReplacements = [];
      loadPromise = null;
      setReplacements([]);
      return;
    }

    if (cachedReplacements !== null) {
      setReplacements(cachedReplacements);
      return;
    }
    loadReplacements().then(setReplacements);
  }, []);

  return useCallback(
    (text: string) => applyReplacements(text, replacements),
    [replacements],
  );
}
