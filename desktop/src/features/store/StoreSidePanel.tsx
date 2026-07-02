/**
 * Store side panel.
 *
 * Recent source-backed changes are the publish surface. The worker resolves the
 * selected feature names to source material and metadata during publish, so the
 * panel no longer runs a separate draft/review loop first.
 */
import { useCallback, useEffect, useState } from "react";
import {
  featureKeyOf,
  refreshFeatureSnapshot,
  storeSidePanelStore,
  useStoreSidePanelState,
} from "./store-side-panel-store";
import "./store.css";
import {
  ShareDialog,
  type ShareFeatureRef,
} from "./store-side-panel/ShareDialog";
import { RecentChangesList } from "./store-side-panel/RecentChangesList";
import { StoreIllustration } from "@/shell/display/illustrations/StoreIllustration";

export function StoreSidePanel() {
  const state = useStoreSidePanelState();
  const [publishFeatures, setPublishFeatures] = useState<ShareFeatureRef[]>(
    [],
  );
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    void refreshFeatureSnapshot();
    return () => {
      storeSidePanelStore.reset();
    };
  }, []);

  const handlePublishSelected = useCallback(() => {
    // Selection is keyed on featureId. Display names are NOT unique across
    // roster features, so the publish contract carries the id alongside the
    // name; only legacy rows without one fall back to name resolution.
    const features = [...(state.snapshot?.items ?? []), ...state.olderEntries]
      .filter((item) => state.selectedFeatureKeys.has(featureKeyOf(item)))
      .map((item) => ({ name: item.name, featureId: item.featureId }));
    if (features.length === 0) return;
    setPublishFeatures(features);
    setPublishOpen(true);
  }, [state.snapshot, state.olderEntries, state.selectedFeatureKeys]);

  const handlePublished = useCallback(
    async (_args: { releaseNumber: number }) => {
      storeSidePanelStore.clearSelections();
      setPublishFeatures([]);
      setPublishOpen(false);
    },
    [],
  );

  return (
    <div
      className="right-sidebar__rich right-sidebar__rich--store store-side-panel"
      data-store-display-tab="store"
    >
      <RecentChangesList
        snapshot={state.snapshot}
        snapshotLoading={state.snapshotLoading}
        selectedFeatureKeys={state.selectedFeatureKeys}
        olderEntries={state.olderEntries}
        rosterTotal={state.rosterTotal}
        olderLoading={state.olderLoading}
        onPublishSelected={() => void handlePublishSelected()}
      />

      {(state.snapshot?.items ?? []).length === 0 && !state.snapshotLoading ? (
        <div className="store-side-panel-empty-state">
          <div className="store-side-panel-empty-state-art">
            <StoreIllustration />
          </div>
          <p className="store-side-panel-empty-state-body">
            After Stella makes a change for you, share it with friends, a
            community, or the store from here.
          </p>
        </div>
      ) : null}

      <ShareDialog
        open={publishOpen}
        selectedFeatures={publishFeatures}
        onClose={() => {
          setPublishOpen(false);
          setPublishFeatures([]);
        }}
        onShared={handlePublished}
      />
    </div>
  );
}
