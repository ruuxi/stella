import { type StorePackage, TYPE_GRADIENTS, TYPE_ICONS } from "../constants";

interface PackageDetailProps {
  pkg?: StorePackage;
  installed: boolean;
  installing: boolean;
  onBack: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}

export function PackageDetail({
  pkg,
  installed,
  installing,
  onBack,
  onInstall,
  onUninstall,
}: PackageDetailProps) {
  if (!pkg) {
    return (
      <div className="store-detail">
        <button type="button" className="store-detail-back" onClick={onBack}>
          &larr; Back
        </button>
        <div className="store-empty">Loading package details...</div>
      </div>
    );
  }

  return (
    <div className="store-detail">
      <button type="button" className="store-detail-back" onClick={onBack}>
        &larr; Back
      </button>

      <div
        className="store-detail-banner"
        style={{ background: TYPE_GRADIENTS[pkg.type] || TYPE_GRADIENTS.skill }}
      >
        <span className="store-detail-banner-icon">
          {pkg.icon ?? TYPE_ICONS[pkg.type] ?? "\u{1F4E6}"}
        </span>
      </div>

      <div className="store-detail-header">
        <div className="store-detail-info">
          <div className="store-detail-name">{pkg.name}</div>
          <div className="store-detail-author">by {pkg.author}</div>
          <div className="store-detail-stats">
            <span>v{pkg.version}</span>
            <span>{pkg.type}</span>
            {pkg.downloads > 0 && <span>{pkg.downloads} installs</span>}
          </div>
        </div>
        <div className="store-detail-actions">
          {installed ? (
            <button
              type="button"
              className={`store-detail-btn store-detail-btn--installed${installing ? " store-detail-btn--loading" : ""}`}
              onClick={onUninstall}
            >
              {installing ? "Uninstalling..." : "Installed"}
            </button>
          ) : (
            <button
              type="button"
              className={`store-detail-btn${installing ? " store-detail-btn--loading" : ""}`}
              onClick={onInstall}
            >
              {installing ? "Installing..." : "Get"}
            </button>
          )}
        </div>
      </div>

      {pkg.tags.length > 0 && (
        <div className="store-detail-tags">
          {pkg.tags.map((tag) => (
            <span key={tag} className="store-detail-tag">{tag}</span>
          ))}
        </div>
      )}

      <div className="store-detail-desc">{pkg.description}</div>

      {pkg.readme && (
        <div className="store-detail-readme">{pkg.readme}</div>
      )}
    </div>
  );
}
