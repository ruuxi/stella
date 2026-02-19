import { type StorePackage, TYPE_GRADIENTS, TYPE_ICONS, getAuthorColor } from "../constants";

interface PackageCardProps {
  pkg: StorePackage;
  installed: boolean;
  installing: boolean;
  onDetail: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}

export function PackageCard({
  pkg,
  installed,
  installing,
  onDetail,
  onInstall,
  onUninstall,
}: PackageCardProps) {
  return (
    <div
      className="store-card"
      style={{ background: TYPE_GRADIENTS[pkg.type] || TYPE_GRADIENTS.skill }}
      onClick={onDetail}
    >
      <div className="store-card-inner">
        <div className="store-card-header">
          <div className="store-card-left">
            <div className="store-card-title">{pkg.name}</div>
            <div className="store-card-status">
              <span className="store-status-dot" />
              {pkg.downloads > 0 ? `${pkg.downloads} installs` : pkg.type}
            </div>
          </div>
          <div className="store-card-right">
            <div className="store-author-row">
              <span className="store-author-avatar store-author-avatar--sm" style={{ background: getAuthorColor(pkg.author) }}>
                {pkg.author.charAt(0).toUpperCase()}
              </span>
              <span className="store-card-author-name">{pkg.author}</span>
            </div>
          </div>
        </div>
        <div className="store-card-center">
          <span className="store-card-icon">
            {pkg.icon ?? TYPE_ICONS[pkg.type] ?? "\u{1F4E6}"}
          </span>
        </div>
        <div className="store-card-footer">
          <p className="store-card-desc">{pkg.description}</p>
          <div className="store-card-action" onClick={(e) => e.stopPropagation()}>
            {installed ? (
              <button
                type="button"
                className={`store-card-btn store-card-btn--installed${installing ? " store-card-btn--loading" : ""}`}
                onClick={onUninstall}
              >
                {installing ? "..." : "Installed"}
              </button>
            ) : (
              <button
                type="button"
                className={`store-card-btn${installing ? " store-card-btn--loading" : ""}`}
                onClick={onInstall}
              >
                {installing ? "..." : "Get"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
