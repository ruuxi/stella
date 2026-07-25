/**
 * Files — the merged Canvas + Media surface.
 *
 * One tab for everything Stella can show you: HTML canvases, images, audio,
 * video, PDFs, markdown, office documents, diffs. Its default view is a list;
 * opening an entry renders it in place.
 *
 * Sub-location (`sidebarSections` → `locations.files`) is the display-tab id of
 * the open artifact, or `null` for the list. Artifact payloads arriving from an
 * agent register a viewer in `displayTabs` and point this section at it, so the
 * workspace-display payload system keeps working unchanged — it just targets
 * Files now instead of separate Canvas and Media tabs.
 */

import {
  sidebarSections,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayTabList } from "@/features/workspace-display/tab-store";
import { ChevronLeft } from "@/ui/icons";
import { DeferredDisplayContent } from "./DeferredDisplayContent";

export function FilesSection() {
  const openTabId = useSidebarSectionLocation("files");
  const { tabs } = useDisplayTabList();

  // A remembered id can outlive its tab (the registry is not persisted across
  // launches). Falling back to the list is the graceful degradation.
  const openTab = openTabId
    ? (tabs.find((tab) => tab.id === openTabId) ?? null)
    : null;

  if (!openTab) {
    return (
      <div className="sidebar-section__empty">
        Files Stella creates or opens will show up here.
      </div>
    );
  }

  return (
    <>
      <div className="sidebar-section__viewer-head">
        <button
          type="button"
          className="sidebar-section__back"
          onClick={() => sidebarSections.clearLocation("files")}
          aria-label="Back to files"
        >
          <ChevronLeft size={15} strokeWidth={1.75} aria-hidden="true" />
          Files
        </button>
        <span className="sidebar-section__viewer-title">{openTab.title}</span>
      </div>
      <div className="sidebar-section__viewer-body">
        <DeferredDisplayContent key={openTab.id} render={openTab.render} />
      </div>
    </>
  );
}
