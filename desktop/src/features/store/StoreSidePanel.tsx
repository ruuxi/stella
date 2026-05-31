/**
 * Store side panel.
 *
 * Recent source-backed changes are the publish surface. The worker resolves the
 * selected feature names to source material and metadata during publish, so the
 * panel no longer runs a separate draft/review loop first.
 */
import { useCallback, useEffect, useState } from "react";
import {
  refreshFeatureSnapshot,
  storeSidePanelStore,
  useStoreSidePanelState,
} from "./store-side-panel-store";
import "./store.css";
import { PublishDialog } from "./store-side-panel/PublishDialog";
import { RecentChangesList } from "./store-side-panel/RecentChangesList";
import { StoreIllustration } from "@/shell/display/illustrations/StoreIllustration";

export function StoreSidePanel() {
  const state = useStoreSidePanelState();
  const [publishFeatureNames, setPublishFeatureNames] = useState<string[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    void refreshFeatureSnapshot();
    return () => {
      storeSidePanelStore.reset();
    };
  }, []);

  const handlePublishSelected = useCallback(() => {
    const names = Array.from(state.selectedFeatureNames);
    if (names.length === 0) return;
    setPublishFeatureNames(names);
    setPublishOpen(true);
  }, [state.selectedFeatureNames]);

  const handlePublished = useCallback(
    async (_args: { releaseNumber: number }) => {
      storeSidePanelStore.clearSelections();
      setPublishFeatureNames([]);
      setPublishOpen(false);
    },
    [],
  );

  return (
    <div
      className="display-sidebar__rich display-sidebar__rich--store store-side-panel"
      data-store-display-tab="store"
    >
      <RecentChangesList
        snapshot={state.snapshot}
        snapshotLoading={state.snapshotLoading}
        selectedFeatureNames={state.selectedFeatureNames}
        onPublishSelected={() => void handlePublishSelected()}
      />

      {(state.snapshot?.items ?? []).length === 0 && !state.snapshotLoading ? (
        <div className="store-side-panel-empty-state">
          <div className="store-side-panel-empty-state-art">
            <StoreIllustration />
          </div>
          <p className="store-side-panel-empty-state-body">
            After Stella makes a change for you, publish it to the store from
            here.
          </p>
        </div>
      ) : null}

      <PublishDialog
        open={publishOpen}
        selectedFeatureNames={publishFeatureNames}
        onClose={() => {
          setPublishOpen(false);
          setPublishFeatureNames([]);
        }}
        onPublished={handlePublished}
      />
    </div>
  );
}
