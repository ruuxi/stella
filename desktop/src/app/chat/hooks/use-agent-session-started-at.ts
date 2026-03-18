import { useEffect, useState } from "react";

let cachedAppSessionStartedAt: number | null | undefined;
let pendingAppSessionStartedAt: Promise<number | null> | null = null;

const loadAppSessionStartedAt = async (): Promise<number | null> => {
  const getAppSessionStartedAt = window.electronAPI?.agent.getAppSessionStartedAt;
  if (!getAppSessionStartedAt) {
    cachedAppSessionStartedAt = null;
    return null;
  }

  try {
    const value = await getAppSessionStartedAt();
    cachedAppSessionStartedAt = Number.isFinite(value) ? value : null;
    return cachedAppSessionStartedAt;
  } catch {
    cachedAppSessionStartedAt = null;
    return null;
  }
};

export function useAgentSessionStartedAt(): number | null {
  const [appSessionStartedAt, setAppSessionStartedAt] = useState<number | null>(
    cachedAppSessionStartedAt ?? null,
  );

  useEffect(() => {
    if (cachedAppSessionStartedAt !== undefined) {
      return;
    }

    if (!pendingAppSessionStartedAt) {
      pendingAppSessionStartedAt = loadAppSessionStartedAt().finally(() => {
        pendingAppSessionStartedAt = null;
      });
    }

    let cancelled = false;
    void pendingAppSessionStartedAt.then((value) => {
      if (!cancelled) {
        setAppSessionStartedAt(value);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return appSessionStartedAt;
}
