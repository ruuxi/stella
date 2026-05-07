import { RefreshCw } from "lucide-react";
import {
  refreshFeatureSnapshot,
  storeSidePanelStore,
} from "../store-side-panel-store";
import type { SelfModFeatureSnapshot } from "../../../shared/types/electron";
import { formatTimeAgo } from "./format";

type RecentRowProps = {
  name: string;
  meta: string | null;
  selected: boolean;
  onAdd: () => void;
  onPublish: () => void;
};

function RecentRow({ name, meta, selected, onAdd, onPublish }: RecentRowProps) {
  return (
    <div className="store-side-panel-row" data-selected={selected || undefined}>
      <div className="store-side-panel-row-text">
        <span className="store-side-panel-row-title">{name}</span>
        {meta ? (
          <span className="store-side-panel-row-meta">{meta}</span>
        ) : null}
      </div>
      <div className="store-side-panel-row-actions">
        <button
          type="button"
          className="store-side-panel-pill"
          data-active={selected || undefined}
          onClick={onAdd}
          title={selected ? "Remove from composer" : "Add to composer"}
        >
          {selected ? "Added" : "Add"}
        </button>
        <button
          type="button"
          className="store-side-panel-pill"
          data-variant="primary"
          onClick={onPublish}
          title="Draft a blueprint to publish this change"
        >
          Publish
        </button>
      </div>
    </div>
  );
}

type RecentChangesListProps = {
  snapshot: SelfModFeatureSnapshot | null;
  snapshotLoading: boolean;
  selectedFeatureNames: ReadonlySet<string>;
  onPublish: (name: string) => void;
};

export function RecentChangesList({
  snapshot,
  snapshotLoading,
  selectedFeatureNames,
  onPublish,
}: RecentChangesListProps) {
  const items = snapshot?.items ?? [];
  return (
    <>
      <div className="store-side-panel-header">
        <span>Recent changes</span>
        <button
          type="button"
          className="store-side-panel-refresh"
          onClick={() => void refreshFeatureSnapshot()}
          disabled={snapshotLoading}
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {snapshotLoading && items.length === 0 ? (
        <div className="store-side-panel-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="store-side-panel-empty">
          No recent changes yet. After Stella makes a change for you, it'll show
          up here.
        </div>
      ) : (
        <div className="store-side-panel-list">
          {items.map((item, index) => {
            const selected = selectedFeatureNames.has(item.name);
            return (
              <RecentRow
                key={`${index}:${item.name}`}
                name={item.name}
                meta={
                  snapshot?.generatedAt
                    ? `Updated ${formatTimeAgo(snapshot.generatedAt)}`
                    : null
                }
                selected={selected}
                onAdd={() => storeSidePanelStore.toggleFeature(item.name)}
                onPublish={() => onPublish(item.name)}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
