import { type StoreUpdatePackage, TYPE_GRADIENTS, TYPE_ICONS } from "../constants";

interface UpdatesListProps {
  updates: StoreUpdatePackage[];
  installingIds: Set<string>;
  onDetail: (packageId: string) => void;
  onUpdate: (packageId: string) => void;
}

export function UpdatesList({
  updates,
  installingIds,
  onDetail,
  onUpdate,
}: UpdatesListProps) {
  if (updates.length === 0) {
    return <div className="store-empty">All packages are up to date</div>;
  }

  return (
    <div className="store-installed-list">
      {updates.map((pkg) => (
        <div
          key={pkg.packageId}
          className="store-installed-item"
          onClick={() => onDetail(pkg.packageId)}
        >
          <div
            className="store-installed-icon"
            style={{ background: TYPE_GRADIENTS[pkg.type] || TYPE_GRADIENTS.skill }}
          >
            {pkg.icon ?? TYPE_ICONS[pkg.type] ?? "\u{1F4E6}"}
          </div>
          <div className="store-installed-info">
            <div className="store-installed-name">{pkg.name}</div>
            <div className="store-installed-version">
              v{pkg.installedVersion} &rarr; v{pkg.version}
            </div>
          </div>
          <button
            type="button"
            className="store-update-btn"
            onClick={(e) => {
              e.stopPropagation();
              onUpdate(pkg.packageId);
            }}
            disabled={installingIds.has(pkg.packageId)}
          >
            {installingIds.has(pkg.packageId) ? "..." : "Update"}
          </button>
        </div>
      ))}
    </div>
  );
}
