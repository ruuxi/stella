import {
  type InstalledRecord,
  type StorePackage,
  TYPE_GRADIENTS,
  TYPE_ICONS,
} from "../constants";

interface InstalledListProps {
  installedRecords?: InstalledRecord[];
  packageLookup: Map<string, StorePackage>;
  installingIds: Set<string>;
  onDetail: (packageId: string) => void;
  onUninstall: (packageId: string) => void;
}

export function InstalledList({
  installedRecords,
  packageLookup,
  installingIds,
  onDetail,
  onUninstall,
}: InstalledListProps) {
  if (!installedRecords || installedRecords.length === 0) {
    return <div className="store-empty">No installed packages</div>;
  }

  return (
    <div className="store-installed-list">
      {installedRecords.map((rec) => {
        const pkg = packageLookup.get(rec.packageId);
        return (
          <div
            key={rec.packageId}
            className="store-installed-item"
            onClick={() => onDetail(rec.packageId)}
          >
            <div
              className="store-installed-icon"
              style={{ background: TYPE_GRADIENTS[pkg?.type ?? "skill"] || TYPE_GRADIENTS.skill }}
            >
              {pkg?.icon ?? TYPE_ICONS[pkg?.type ?? "skill"] ?? "\u{1F4E6}"}
            </div>
            <div className="store-installed-info">
              <div className="store-installed-name">{pkg?.name ?? rec.packageId}</div>
              <div className="store-installed-version">v{rec.installedVersion}</div>
            </div>
            <button
              type="button"
              className="store-uninstall-btn"
              onClick={(e) => {
                e.stopPropagation();
                onUninstall(rec.packageId);
              }}
              disabled={installingIds.has(rec.packageId)}
            >
              {installingIds.has(rec.packageId) ? "..." : "Uninstall"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
