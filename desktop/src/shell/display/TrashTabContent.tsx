/**
 * Display-sidebar tab body for Stella's deferred-delete trash.
 *
 * The runtime moves agent-deleted paths into `state/deferred-delete/trash`
 * for 24h before purging. This view lists the staged items and offers
 * per-row + bulk "Delete now" actions backed by the privileged IPC at
 * `displayTrash:list` / `displayTrash:forceDelete`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { displayTabs } from "./tab-store";

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

  return (
    <div
      className="display-sidebar__rich display-sidebar__rich--trash"
      data-display-tab="trash"
    >
      <section className="display-file-preview display-file-preview--trash">
        <header className="display-file-preview__header">
          <div className="display-file-preview__title-group">
            <span className="display-file-preview__eyebrow">Trash</span>
            <div className="display-file-preview__title">
              {sorted.length === 0
                ? "No items in trash"
                : `${sorted.length} item${sorted.length === 1 ? "" : "s"} · auto-delete in 24h`}
            </div>
          </div>
          <div className="display-file-preview__actions">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading || emptying}
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void handleEmptyAll()}
              disabled={sorted.length === 0 || emptying}
            >
              {emptying ? "Emptying…" : "Empty trash"}
            </button>
          </div>
        </header>

        {errors.length > 0 && (
          <div className="display-file-preview__error">
            {errors.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </div>
        )}

        {loading ? (
          <div className="display-file-preview__empty">Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="display-file-preview__empty">
            Stella's agent hasn't deleted any files recently. When it does,
            they'll show here for 24 hours so you can recover or purge them.
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => displayTabs.setPanelOpen(false)}
                className="display-trash__close"
              >
                Close panel
              </button>
            </div>
          </div>
        ) : (
          <ul className="display-trash__list">
            {sorted.map((item) => {
              const remaining = item.purgeAfter - now;
              const expired = remaining <= 0;
              return (
                <li key={item.id} className="display-trash__row">
                  <div className="display-trash__row-main">
                    <div
                      className="display-trash__name"
                      title={item.originalPath}
                    >
                      {basenameOf(item.originalPath)}
                    </div>
                    <div
                      className="display-trash__path"
                      title={item.originalPath}
                    >
                      {dirnameOf(item.originalPath)}
                    </div>
                    <div className="display-trash__meta">
                      <span>
                        Trashed {formatRelative(now - item.trashedAt)} ago
                      </span>
                      <span className="display-trash__sep">·</span>
                      <span>
                        {expired
                          ? "Pending purge"
                          : `Auto-delete in ${formatRelative(remaining)}`}
                      </span>
                      <span className="display-trash__sep">·</span>
                      <span>{item.source}</span>
                    </div>
                  </div>
                  <div className="display-trash__row-actions">
                    <button
                      type="button"
                      onClick={() => void handleForceDelete(item.id)}
                      disabled={busyId === item.id}
                    >
                      {busyId === item.id ? "Deleting…" : "Delete now"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
