import { Check, Plus } from "@/ui/icons";
import {
  featureKeyOf,
  loadOlderFeatureEntries,
  storeSidePanelStore,
  type StoreSidePanelOlderEntry,
} from "../store-side-panel-store";
import type { SelfModFeatureSnapshot } from "../../../shared/types/electron";
import { formatTimeAgo } from "./format";

type RecentRowProps = {
  name: string;
  meta: string | null;
  selected: boolean;
  onToggle: () => void;
};

function RecentRow({ name, meta, selected, onToggle }: RecentRowProps) {
  return (
    <div
      className="store-side-panel-row"
      data-selected={selected || undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
      title={
        selected
          ? "Click to remove from selection"
          : "Click to include in publish"
      }
    >
      <span
        className="store-side-panel-row-glyph"
        data-selected={selected || undefined}
        aria-hidden
      >
        {selected ? (
          <Check size={12} strokeWidth={2.4} />
        ) : (
          <Plus size={12} strokeWidth={2} />
        )}
      </span>
      <div className="store-side-panel-row-text">
        <span className="store-side-panel-row-title">{name}</span>
        {meta ? (
          <span className="store-side-panel-row-meta">{meta}</span>
        ) : null}
      </div>
    </div>
  );
}

function publishButtonLabel(selectedCount: number): string {
  if (selectedCount === 0) return "Select changes to publish";
  if (selectedCount === 1) return "Publish · 1 selected";
  return `Publish · ${selectedCount} selected`;
}

type RecentChangesListProps = {
  snapshot: SelfModFeatureSnapshot | null;
  snapshotLoading: boolean;
  selectedFeatureKeys: ReadonlySet<string>;
  olderEntries: StoreSidePanelOlderEntry[];
  rosterTotal: number | null;
  olderLoading: boolean;
  publishDisabled?: boolean;
  onPublishSelected: () => void;
};

export function RecentChangesList({
  snapshot,
  selectedFeatureKeys,
  olderEntries,
  rosterTotal,
  olderLoading,
  publishDisabled = false,
  onPublishSelected,
}: RecentChangesListProps) {
  const items = snapshot?.items ?? [];
  const selectedCount = selectedFeatureKeys.size;
  if (items.length === 0) return null;
  const shownCount = items.length + olderEntries.length;
  const hasOlder = rosterTotal !== null && rosterTotal > shownCount;
  return (
    <div className="store-side-panel-recent">
      <div className="store-side-panel-list">
        {items.map((item, index) => {
          const key = featureKeyOf(item);
          const selected = selectedFeatureKeys.has(key);
          return (
            <RecentRow
              key={`${index}:${key}`}
              name={item.name}
              meta={
                snapshot?.generatedAt
                  ? `Updated ${formatTimeAgo(snapshot.generatedAt)}`
                  : null
              }
              selected={selected}
              onToggle={() => storeSidePanelStore.toggleFeature(key)}
            />
          );
        })}
        {olderEntries.map((entry) => {
          const key = featureKeyOf(entry);
          const selected = selectedFeatureKeys.has(key);
          return (
            <RecentRow
              key={key}
              name={entry.name}
              meta={`Updated ${formatTimeAgo(entry.lastCommitAt)}`}
              selected={selected}
              onToggle={() => storeSidePanelStore.toggleFeature(key)}
            />
          );
        })}
        {hasOlder ? (
          <button
            type="button"
            className="store-side-panel-show-older"
            disabled={olderLoading}
            onClick={() => void loadOlderFeatureEntries()}
          >
            {olderLoading ? "Loading…" : "Show older"}
          </button>
        ) : null}
      </div>
      <div className="store-side-panel-publish-bar">
        <button
          type="button"
          className="store-side-panel-publish-btn"
          disabled={selectedCount === 0 || publishDisabled}
          onClick={onPublishSelected}
        >
          {publishButtonLabel(selectedCount)}
        </button>
      </div>
    </div>
  );
}
