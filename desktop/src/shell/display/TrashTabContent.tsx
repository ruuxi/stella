/**
 * Display-sidebar tab body for Stella's deferred-delete trash.
 *
 * The runtime moves agent-deleted paths into `state/deferred-delete/trash`
 * for 24h before purging. This view lists the staged items and offers
 * per-row + bulk "Delete now" actions backed by the privileged IPC at
 * `displayTrash:list` / `displayTrash:forceDelete`.
 *
 * Visual language follows the broader display-tab style: quiet
 * sentence-case heading, Finder-like rows, pill-btn actions, no
 * decorative dots.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { TrashIllustration } from "./illustrations/TrashIllustration";
import "./trash-tab.css";

type TrashRecord = {
  id: string;
  source: string;
  originalPath: string;
  trashPath: string;
  trashedAt: number;
  purgeAfter: number;
  requestId?: string;
  agentType?: string;
  conversationId?: string;
};

type TrashListResult = {
  items: TrashRecord[];
  errors: string[];
};

const formatRelative = (ms: number): string => {
  const abs = Math.abs(ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return "just now";
  if (abs < hour) return `${Math.round(abs / minute)}m`;
  if (abs < day) return `${Math.round(abs / hour)}h`;
  return `${Math.round(abs / day)}d`;
};

const basenameOf = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;

const dirnameOf = (filePath: string): string => {
  const parts = filePath.split(/[\\/]/);
  parts.pop();
  return parts.join("/");
};

export const TrashTabContent = () => {
  const [items, setItems] = useState<TrashRecord[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.display?.listTrash;
    if (!api) {
      setLoading(false);
      setErrors(["Trash is unavailable in this build."]);
      return;
    }
    try {
      const result = (await api()) as TrashListResult | null;
      setItems(result?.items ?? []);
      setErrors(result?.errors ?? []);
    } catch (error) {
      setErrors([(error as Error).message]);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  const handleForceDelete = useCallback(
    async (id: string) => {
      const api = window.electronAPI?.display?.forceDeleteTrash;
      if (!api) return;
      setBusyId(id);
      try {
        await api({ id });
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const handleEmptyAll = useCallback(async () => {
    const api = window.electronAPI?.display?.forceDeleteTrash;
    if (!api || items.length === 0) return;
    setEmptying(true);
    try {
      await api({ all: true });
      await refresh();
    } finally {
      setEmptying(false);
    }
  }, [items.length, refresh]);

  const sorted = useMemo(
    () => [...items].sort((a, b) => b.trashedAt - a.trashedAt),
    [items],
  );

  const subtitle =
    sorted.length === 0
      ? loading
        ? "Loading…"
        : "Nothing here right now."
      : `${sorted.length} item${sorted.length === 1 ? "" : "s"} — auto-deleted in 24 hours.`;

  if (sorted.length === 0 && !loading) {
    return (
      <div className="trash-tab" data-display-tab="trash" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", padding: 40, textAlign: "center", gap: 12 }}>
        <div style={{ width: 200, height: 150, opacity: 0.9 }}>
          <TrashIllustration />
        </div>
        <h3 className="trash-tab__title" style={{ margin: 0 }}>Trash</h3>
        <p className="trash-tab__subtitle" style={{ margin: 0, fontSize: 15 }}>Nothing here right now.</p>
        {errors.length > 0 && (
          <div className="trash-tab__errors">
            {errors.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="trash-tab" data-display-tab="trash">
      <header className="trash-tab__header">
        <div>
          <h3 className="trash-tab__title">Trash</h3>
          <p className="trash-tab__subtitle">{subtitle}</p>
        </div>
        <div className="trash-tab__header-actions">
          <button
            type="button"
            className="pill-btn"
            onClick={() => void refresh()}
            disabled={loading || emptying}
          >
            Refresh
          </button>
          <button
            type="button"
            className="pill-btn pill-btn--danger"
            onClick={() => void handleEmptyAll()}
            disabled={sorted.length === 0 || emptying}
          >
            {emptying ? "Emptying…" : "Empty trash"}
          </button>
        </div>
      </header>

      {errors.length > 0 && (
        <div className="trash-tab__errors">
          {errors.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      )}

      {sorted.length === 0 && !loading && (
        <div className="trash-tab__empty-state" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, opacity: 0.8 }}>
          <div style={{ width: 160, height: 120, marginBottom: 16 }}>
            <TrashIllustration />
          </div>
        </div>
      )}

      {sorted.length > 0 && (
        <ul className="trash-tab__list">
          {sorted.map((item) => {
            const remaining = item.purgeAfter - now;
            const expired = remaining <= 0;
            const folder = dirnameOf(item.originalPath);
            return (
              <li key={item.id} className="trash-tab__row">
                <div className="trash-tab__row-main">
                  <div className="trash-tab__name" title={item.originalPath}>
                    {basenameOf(item.originalPath)}
                  </div>
                  {folder && (
                    <div className="trash-tab__path" title={item.originalPath}>
                      {folder}
                    </div>
                  )}
                  <div className="trash-tab__meta">
                    <span>Trashed {formatRelative(now - item.trashedAt)} ago</span>
                    <span>
                      {expired
                        ? "Pending purge"
                        : `Auto-deletes in ${formatRelative(remaining)}`}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="pill-btn pill-btn--danger trash-tab__row-action"
                  onClick={() => void handleForceDelete(item.id)}
                  disabled={busyId === item.id}
                >
                  {busyId === item.id ? "Deleting…" : "Delete now"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
