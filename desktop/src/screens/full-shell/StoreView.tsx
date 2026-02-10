/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useUiState } from "@/app/state/ui-state";
import { registerTheme, unregisterTheme } from "@/theme/themes";
import type { Theme } from "@/theme/themes/types";

type StorePage = "browse" | "detail" | "installed" | "updates";
type PackageType = "skill" | "canvas" | "plugin" | "theme" | "mod";
type CategoryTab = "all" | PackageType;

const CATEGORY_TABS: { label: string; value: CategoryTab }[] = [
  { label: "All", value: "all" },
  { label: "Mods", value: "mod" },
  { label: "Skills", value: "skill" },
  { label: "Mini-apps", value: "canvas" },
  { label: "Themes", value: "theme" },
  { label: "Plugins", value: "plugin" },
];

const TYPE_ICONS: Record<string, string> = {
  skill: "\u2728",
  canvas: "\u{1F3A8}",
  plugin: "\u{1F50C}",
  theme: "\u{1F308}",
  mod: "\u2699\uFE0F",
};

const TYPE_GRADIENTS: Record<string, string> = {
  skill: "linear-gradient(135deg, #ff6b35 0%, #f7c948 100%)",
  canvas: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  plugin: "linear-gradient(135deg, #11998e 0%, #38ef7d 100%)",
  theme: "linear-gradient(135deg, #ee5a6f 0%, #f093fb 100%)",
  mod: "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
};

function getAuthorColor(name: string): string {
  const colors = [
    "#e74c3c", "#e67e22", "#2ecc71", "#1abc9c",
    "#3498db", "#9b59b6", "#e84393", "#6c5ce7",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

interface StoreViewProps {
  onBack: () => void;
  onComposePrompt: (text: string) => void;
}

type StorePackage = {
  _id: string;
  packageId: string;
  name: string;
  author: string;
  description: string;
  type: PackageType;
  version: string;
  tags: string[];
  downloads: number;
  rating?: number;
  icon?: string;
  readme?: string;
  modPayload?: unknown;
  implementation?: string;
};

function StoreView({ onComposePrompt }: StoreViewProps) {
  const { setView } = useUiState();
  const [page, setPage] = useState<StorePage>("browse");
  const [category, setCategory] = useState<CategoryTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());

  // Convex queries
  const typeFilter = category === "all" ? undefined : category;
  const browsePackages = useQuery(
    api.data.store_packages.list as any,
    searchQuery ? "skip" : { type: typeFilter },
  ) as StorePackage[] | undefined;
  const searchResults = useQuery(
    api.data.store_packages.search as any,
    searchQuery ? { query: searchQuery, type: typeFilter } : "skip",
  ) as StorePackage[] | undefined;

  const installedRecords = useQuery(
    api.data.store_packages.getInstalled as any,
    {},
  ) as { packageId: string; installedVersion: string }[] | undefined;

  const selectedPackage = useQuery(
    api.data.store_packages.getByPackageId as any,
    selectedPackageId ? { packageId: selectedPackageId } : "skip",
  ) as StorePackage | null | undefined;
  const allPackages = useQuery(
    api.data.store_packages.list as any,
    { type: undefined },
  ) as StorePackage[] | undefined;

  const installMutation = useMutation(api.data.store_packages.install as any);
  const uninstallMutation = useMutation(api.data.store_packages.uninstall as any);

  const installedSet = useMemo(() => {
    const set = new Set<string>();
    if (installedRecords) {
      for (const rec of installedRecords) {
        set.add(rec.packageId);
      }
    }
    return set;
  }, [installedRecords]);

  const packages = searchQuery ? searchResults : browsePackages;
  const packageLookup = useMemo(() => {
    const byId = new Map<string, StorePackage>();
    for (const pkg of allPackages ?? []) {
      byId.set(pkg.packageId, pkg);
    }
    for (const pkg of browsePackages ?? []) {
      byId.set(pkg.packageId, pkg);
    }
    for (const pkg of searchResults ?? []) {
      byId.set(pkg.packageId, pkg);
    }
    return byId;
  }, [allPackages, browsePackages, searchResults]);
  const updates = useMemo(() => {
    if (!installedRecords) return [];
    return installedRecords
      .map((rec) => {
        const pkg = packageLookup.get(rec.packageId);
        if (!pkg) return null;
        if (pkg.version === rec.installedVersion) return null;
        return {
          ...pkg,
          installedVersion: rec.installedVersion,
        };
      })
      .filter(
        (
          value,
        ): value is StorePackage & {
          installedVersion: string;
        } => Boolean(value),
      );
  }, [installedRecords, packageLookup]);

  const featured = useMemo(() => {
    if (!allPackages || allPackages.length === 0) return null;
    return [...allPackages].sort((a, b) => (b.downloads || 0) - (a.downloads || 0))[0];
  }, [allPackages]);

  const gridPackages = useMemo(() => {
    if (!packages) return packages;
    if (searchQuery || !featured) return packages;
    return packages.filter((p) => p.packageId !== featured.packageId);
  }, [packages, featured, searchQuery]);

  const totalPackageCount = allPackages?.length ?? 0;
  const installedCount = installedRecords?.length ?? 0;

  const openDetail = useCallback((packageId: string) => {
    setSelectedPackageId(packageId);
    setPage("detail");
  }, []);

  const handleInstall = useCallback(
    async (pkg: StorePackage) => {
      if (installingIds.has(pkg.packageId)) return;
      setInstallingIds((prev) => new Set(prev).add(pkg.packageId));

      try {
        if (pkg.type === "mod") {
          setView("chat");
          onComposePrompt(
            `Install the "${pkg.name}" mod from package "${pkg.packageId}". Use SelfModInstallBlueprint with this package ID, adapt it to the current codebase, then apply the feature.`,
          );
        } else if (pkg.type === "skill" && window.electronAPI) {
          const payload = pkg.modPayload as { markdown?: string; agentTypes?: string[]; tags?: string[] } | undefined;
          await (window.electronAPI as any).storeInstallSkill({
            packageId: pkg.packageId,
            skillId: pkg.packageId,
            name: pkg.name,
            markdown: payload?.markdown ?? pkg.description,
            agentTypes: payload?.agentTypes ?? ["general"],
            tags: payload?.tags ?? pkg.tags,
          });
        } else if (pkg.type === "theme" && window.electronAPI) {
          const payload = pkg.modPayload as { light?: Theme["light"]; dark?: Theme["dark"] } | undefined;
          if (payload?.light && payload?.dark) {
            await (window.electronAPI as any).storeInstallTheme({
              packageId: pkg.packageId,
              themeId: pkg.packageId,
              name: pkg.name,
              light: payload.light,
              dark: payload.dark,
            });
            registerTheme({ id: pkg.packageId, name: pkg.name, light: payload.light, dark: payload.dark });
          }
        } else if (pkg.type === "canvas" && window.electronAPI) {
          const payload = pkg.modPayload as
            | {
                workspaceId?: string;
                workspaceName?: string;
                dependencies?: Record<string, string>;
                source?: string;
              }
            | undefined;
          await (window.electronAPI as any).storeInstallCanvas({
            packageId: pkg.packageId,
            workspaceId: payload?.workspaceId ?? pkg.packageId,
            name: payload?.workspaceName ?? pkg.name,
            dependencies: payload?.dependencies,
            source: payload?.source,
          });
        } else if (pkg.type === "plugin" && window.electronAPI) {
          const payload = pkg.modPayload as
            | {
                pluginId?: string;
                version?: string;
                description?: string;
                manifest?: Record<string, unknown>;
                files?: Record<string, string>;
              }
            | undefined;
          await (window.electronAPI as any).storeInstallPlugin({
            packageId: pkg.packageId,
            pluginId: payload?.pluginId ?? pkg.packageId,
            name: pkg.name,
            version: payload?.version ?? pkg.version,
            description: payload?.description ?? pkg.description,
            manifest: payload?.manifest,
            files: payload?.files,
          });
        }

        // Record install in backend
        await installMutation({ packageId: pkg.packageId, version: pkg.version });
      } catch (err) {
        console.error("Install failed:", err);
      } finally {
        setInstallingIds((prev) => {
          const next = new Set(prev);
          next.delete(pkg.packageId);
          return next;
        });
      }
    },
    [installingIds, installMutation, onComposePrompt, setView],
  );

  const handleUninstall = useCallback(
    async (pkg: StorePackage) => {
      if (installingIds.has(pkg.packageId)) return;
      setInstallingIds((prev) => new Set(prev).add(pkg.packageId));

      try {
        if (pkg.type === "mod") {
          setView("chat");
          onComposePrompt(
            `Uninstall the "${pkg.name}" mod (package "${pkg.packageId}") by reverting its applied self-mod feature batches, then confirm cleanup.`,
          );
        } else if (window.electronAPI) {
          await (window.electronAPI as any).storeUninstall({
            packageId: pkg.packageId,
            type: pkg.type,
            localId: pkg.packageId,
          });
        }

        if (pkg.type === "theme") {
          unregisterTheme(pkg.packageId);
        }

        await uninstallMutation({ packageId: pkg.packageId });
      } catch (err) {
        console.error("Uninstall failed:", err);
      } finally {
        setInstallingIds((prev) => {
          const next = new Set(prev);
          next.delete(pkg.packageId);
          return next;
        });
      }
    },
    [installingIds, onComposePrompt, setView, uninstallMutation],
  );

  return (
    <div className="store-view">
      <StoreHeader
        page={page}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onPageChange={setPage}
      />

      {page === "browse" && (
        <div className="store-browse">
          {!searchQuery && featured && (
            <FeaturedHero
              featured={featured}
              installed={installedSet.has(featured.packageId)}
              installing={installingIds.has(featured.packageId)}
              onDetail={() => openDetail(featured.packageId)}
              onInstall={() => handleInstall(featured)}
              onUninstall={() => handleUninstall(featured)}
              totalCount={totalPackageCount}
              installedCount={installedCount}
              updatesCount={updates.length}
              onCategorySelect={setCategory}
            />
          )}
          {category !== "all" && (
            <div className="store-filter-bar">
              <span className="store-filter-label">
                {CATEGORY_TABS.find((t) => t.value === category)?.label}
              </span>
              <button
                type="button"
                className="store-filter-clear"
                onClick={() => setCategory("all")}
              >
                Show all
              </button>
            </div>
          )}
          {!gridPackages || gridPackages.length === 0 ? (
            <div className="store-empty">
              {gridPackages === undefined ? "Loading packages..." : "No packages found"}
            </div>
          ) : (
            <div className="store-grid-section">
              <div className="store-grid">
                {gridPackages.map((pkg) => (
                  <PackageCard
                    key={pkg.packageId}
                    pkg={pkg}
                    installed={installedSet.has(pkg.packageId)}
                    installing={installingIds.has(pkg.packageId)}
                    onDetail={() => openDetail(pkg.packageId)}
                    onInstall={() => handleInstall(pkg)}
                    onUninstall={() => handleUninstall(pkg)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {page === "detail" && (
        <PackageDetail
          pkg={selectedPackage ?? undefined}
          installed={selectedPackage ? installedSet.has(selectedPackage.packageId) : false}
          installing={selectedPackage ? installingIds.has(selectedPackage.packageId) : false}
          onBack={() => { setPage("browse"); setSelectedPackageId(null); }}
          onInstall={() => selectedPackage && handleInstall(selectedPackage)}
          onUninstall={() => selectedPackage && handleUninstall(selectedPackage)}
        />
      )}

      {page === "installed" && (
        <div className="store-content">
          <InstalledList
            installedRecords={installedRecords}
            packageLookup={packageLookup}
            installingIds={installingIds}
            onDetail={openDetail}
            onUninstall={(packageId) => {
              const pkg = packageLookup.get(packageId);
              if (pkg) handleUninstall(pkg);
            }}
          />
        </div>
      )}
      {page === "updates" && (
        <div className="store-content">
          <UpdatesList
            updates={updates}
            installingIds={installingIds}
            onDetail={openDetail}
            onUpdate={(packageId) => {
              const pkg = packageLookup.get(packageId);
              if (pkg) handleInstall(pkg);
            }}
          />
        </div>
      )}
    </div>
  );
}

/* ---- Sub-components ---- */

function StoreHeader({
  page,
  searchQuery,
  onSearchChange,
  onPageChange,
}: {
  page: StorePage;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onPageChange: (p: StorePage) => void;
}) {
  return (
    <div className="store-header">
      <div className="store-header-tabs">
        <button
          type="button"
          className={`store-header-tab${page === "browse" ? " store-header-tab--active" : ""}`}
          onClick={() => onPageChange("browse")}
        >
          Browse
        </button>
        <button
          type="button"
          className={`store-header-tab${page === "installed" ? " store-header-tab--active" : ""}`}
          onClick={() => onPageChange("installed")}
        >
          Installed
        </button>
        <button
          type="button"
          className={`store-header-tab${page === "updates" ? " store-header-tab--active" : ""}`}
          onClick={() => onPageChange("updates")}
        >
          Updates
        </button>
      </div>
      <div className="store-header-search">
        <svg className="store-header-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          placeholder="Search packages..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
    </div>
  );
}

function FeaturedHero({
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
}: {
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
}) {
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
            {CATEGORY_TABS.filter((t) => t.value !== "all").map((tab) => (
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

function PackageCard({
  pkg,
  installed,
  installing,
  onDetail,
  onInstall,
  onUninstall,
}: {
  pkg: StorePackage;
  installed: boolean;
  installing: boolean;
  onDetail: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}) {
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

function PackageDetail({
  pkg,
  installed,
  installing,
  onBack,
  onInstall,
  onUninstall,
}: {
  pkg?: StorePackage;
  installed: boolean;
  installing: boolean;
  onBack: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}) {
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

function InstalledList({
  installedRecords,
  packageLookup,
  installingIds,
  onDetail,
  onUninstall,
}: {
  installedRecords?: { packageId: string; installedVersion: string }[];
  packageLookup: Map<string, StorePackage>;
  installingIds: Set<string>;
  onDetail: (packageId: string) => void;
  onUninstall: (packageId: string) => void;
}) {
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
              onClick={(e) => { e.stopPropagation(); onUninstall(rec.packageId); }}
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

function UpdatesList({
  updates,
  installingIds,
  onDetail,
  onUpdate,
}: {
  updates: Array<StorePackage & { installedVersion: string }>;
  installingIds: Set<string>;
  onDetail: (packageId: string) => void;
  onUpdate: (packageId: string) => void;
}) {
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

export default StoreView;
