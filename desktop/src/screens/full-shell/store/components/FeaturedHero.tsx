import {
  CATEGORY_TABS,
  type CategoryTab,
  type StorePackage,
  TYPE_GRADIENTS,
  TYPE_ICONS,
  getAuthorColor,
} from "../constants";

interface FeaturedHeroProps {
  featured: StorePackage;
  installed: boolean;
  installing: boolean;
  onDetail: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  totalCount: number;
  installedCount: number;
  updatesCount: number;
  onCategorySelect: (cat: CategoryTab) => void;
}

export function FeaturedHero({
  featured,
  installed,
  installing,
  onDetail,
  onInstall,
  onUninstall,
  totalCount,
  installedCount,
  updatesCount,
  onCategorySelect,
}: FeaturedHeroProps) {
  return (
    <div className="store-hero">
      <div
        className="store-hero-card"
        style={{ background: TYPE_GRADIENTS[featured.type] || TYPE_GRADIENTS.skill }}
        onClick={onDetail}
      >
        <div className="store-hero-card-inner">
          <div className="store-hero-card-header">
            <div className="store-hero-card-left">
              <h2 className="store-hero-title">{featured.name}</h2>
              <div className="store-status">
                <span className="store-status-dot" />
                {featured.downloads > 0 ? `${featured.downloads} installs` : featured.type}
              </div>
            </div>
            <div className="store-hero-card-right">
              <div className="store-author-row">
                <span className="store-author-avatar" style={{ background: getAuthorColor(featured.author) }}>
                  {featured.author.charAt(0).toUpperCase()}
                </span>
                <span className="store-author-name">{featured.author}</span>
              </div>
              <span className="store-hero-version">v{featured.version}</span>
            </div>
          </div>
          <div className="store-hero-card-center">
            <span className="store-hero-icon">
              {featured.icon ?? TYPE_ICONS[featured.type] ?? "\u{1F4E6}"}
            </span>
          </div>
          <div className="store-hero-card-footer">
            <p className="store-hero-desc">{featured.description}</p>
            <div className="store-hero-actions" onClick={(e) => e.stopPropagation()}>
              {installed ? (
                <button
                  type="button"
                  className={`store-hero-btn store-hero-btn--installed${installing ? " store-hero-btn--loading" : ""}`}
                  onClick={onUninstall}
                >
                  {installing ? "..." : "Installed"}
                </button>
              ) : (
                <button
                  type="button"
                  className={`store-hero-btn${installing ? " store-hero-btn--loading" : ""}`}
                  onClick={onInstall}
                >
                  {installing ? "..." : "Get"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="store-hero-panel">
        <h2 className="store-hero-panel-greeting">Discover</h2>
        <p className="store-hero-panel-sub">{totalCount} packages available</p>
        <div className="store-hero-panel-section">
          <h3 className="store-hero-panel-section-title">Overview</h3>
          <div className="store-hero-panel-stats">
            <div className="store-hero-stat-tile">
              <span className="store-hero-stat-val">{installedCount}</span>
              <span className="store-hero-stat-lbl">Installed</span>
            </div>
            <div className="store-hero-stat-tile">
              <span className="store-hero-stat-val">{updatesCount}</span>
              <span className="store-hero-stat-lbl">Updates</span>
            </div>
          </div>
        </div>
        <div className="store-hero-panel-section">
          <h3 className="store-hero-panel-section-title">Categories</h3>
          <div className="store-hero-panel-cats">
            {CATEGORY_TABS.filter((tab) => tab.value !== "all").map((tab) => (
              <button
                key={tab.value}
                type="button"
                className="store-hero-cat"
                onClick={() => onCategorySelect(tab.value as CategoryTab)}
              >
                <span className="store-hero-cat-icon">{TYPE_ICONS[tab.value] ?? ""}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
