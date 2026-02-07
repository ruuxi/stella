import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useUiState } from "@/app/state/ui-state";
import { registerTheme, unregisterTheme } from "@/theme/themes";
import type { Theme } from "@/theme/themes/types";

type StorePage = "browse" | "detail" | "installed";
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

interface StoreViewProps {
  onBack: () => void;
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

function StoreView({ onBack }: StoreViewProps) {
  const { state, setView } = useUiState();
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

  const ownerId = "local"; // Placeholder; real auth would provide this
  const installedRecords = useQuery(
    api.data.store_packages.getInstalled as any,
    { ownerId },
  ) as { packageId: string; installedVersion: string }[] | undefined;

  const selectedPackage = useQuery(
    api.data.store_packages.getByPackageId as any,
    selectedPackageId ? { packageId: selectedPackageId } : "skip",
  ) as StorePackage | null | undefined;

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

  const openDetail = useCallback((packageId: string) => {
    setSelectedPackageId(packageId);
    setPage("detail");
  }, []);

  const goBack = useCallback(() => {
    if (page === "detail") {
      setPage("browse");
      setSelectedPackageId(null);
    } else {
      onBack();
    }
  }, [page, onBack]);

  const handleInstall = useCallback(
    async (pkg: StorePackage) => {
      if (installingIds.has(pkg.packageId)) return;

      // Mod packages: switch to chat with a prompt
      if (pkg.type === "mod") {
        setView("chat");
        // TODO: pre-fill chat message
        return;
      }

      setInstallingIds((prev) => new Set(prev).add(pkg.packageId));

      try {
        // Install locally via IPC
        if (pkg.type === "skill" && window.electronAPI) {
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
        }

        // Record install in backend
        await installMutation({ ownerId, packageId: pkg.packageId, version: pkg.version });
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
    [installingIds, installMutation, ownerId, setView],
  );

  const handleUninstall = useCallback(
    async (pkg: StorePackage) => {
      if (installingIds.has(pkg.packageId)) return;
      setInstallingIds((prev) => new Set(prev).add(pkg.packageId));

      try {
        if (window.electronAPI) {
          await (window.electronAPI as any).storeUninstall({
            packageId: pkg.packageId,
            type: pkg.type,
            localId: pkg.packageId,
          });
        }

        if (pkg.type === "theme") {
          unregisterTheme(pkg.packageId);
        }

        await uninstallMutation({ ownerId, packageId: pkg.packageId });
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
    [installingIds, uninstallMutation, ownerId],
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
        <>
          <div className="store-tabs">
            {CATEGORY_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                className={`store-tab${category === tab.value ? " store-tab--active" : ""}`}
                onClick={() => setCategory(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="store-content">
            {!packages || packages.length === 0 ? (
              <div className="store-empty">
                {packages === undefined ? "Loading packages..." : "No packages found"}
              </div>
            ) : (
              <div className="store-grid">
                {packages.map((pkg) => (
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
            )}
          </div>
        </>
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
            installingIds={installingIds}
            onDetail={openDetail}
            onUninstall={(packageId) => {
              const pkg = packages?.find((p) => p.packageId === packageId);
              if (pkg) handleUninstall(pkg);
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
      <span className="store-header-title">App Store</span>
      <div className="store-search">
        <span className="store-search-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          type="text"
          placeholder="Search packages..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      <div className="store-header-nav">
        <button
          type="button"
          className={`store-nav-btn${page === "browse" ? " store-nav-btn--active" : ""}`}
          onClick={() => onPageChange("browse")}
        >
          Browse
        </button>
        <button
          type="button"
          className={`store-nav-btn${page === "installed" ? " store-nav-btn--active" : ""}`}
          onClick={() => onPageChange("installed")}
        >
          Installed
        </button>
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
    <div className="store-card" onClick={onDetail}>
      <div className="store-card-header">
        <div className="store-card-icon">
          {pkg.icon ?? TYPE_ICONS[pkg.type] ?? "\u{1F4E6}"}
        </div>
        <div className="store-card-meta">
          <div className="store-card-name">{pkg.name}</div>
          <div className="store-card-author">{pkg.author}</div>
        </div>
      </div>
      <div className="store-card-desc">{pkg.description}</div>
      <div className="store-card-footer">
        <span className="store-card-badge">{pkg.type}</span>
        <span className="store-card-downloads">
          {pkg.downloads > 0 ? `${pkg.downloads} installs` : ""}
        </span>
        <div className="store-card-action" onClick={(e) => e.stopPropagation()}>
          {installed ? (
            <button
              type="button"
              className={`store-install-btn store-install-btn--installed${installing ? " store-install-btn--installing" : ""}`}
              onClick={onUninstall}
            >
              {installing ? "..." : "Installed"}
            </button>
          ) : (
            <button
              type="button"
              className={`store-install-btn${installing ? " store-install-btn--installing" : ""}`}
              onClick={onInstall}
            >
              {installing ? "..." : "Install"}
            </button>
          )}
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

      <div className="store-detail-header">
        <div className="store-detail-icon">
          {pkg.icon ?? TYPE_ICONS[pkg.type] ?? "\u{1F4E6}"}
        </div>
        <div className="store-detail-info">
          <div className="store-detail-name">{pkg.name}</div>
          <div className="store-detail-author">by {pkg.author}</div>
          <div className="store-detail-stats">
            <span>v{pkg.version}</span>
            <span>{pkg.type}</span>
            {pkg.downloads > 0 && <span>{pkg.downloads} installs</span>}
          </div>
        </div>
      </div>

      <div className="store-detail-actions">
        {installed ? (
          <button
            type="button"
            className={`store-detail-install-btn store-detail-install-btn--installed${installing ? " store-detail-install-btn--installing" : ""}`}
            onClick={onUninstall}
          >
            {installing ? "Uninstalling..." : "Installed"}
          </button>
        ) : (
          <button
            type="button"
            className={`store-detail-install-btn${installing ? " store-detail-install-btn--installing" : ""}`}
            onClick={onInstall}
          >
            {installing ? "Installing..." : "Install"}
          </button>
        )}
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
  installingIds,
  onDetail,
  onUninstall,
}: {
  installedRecords?: { packageId: string; installedVersion: string }[];
  installingIds: Set<string>;
  onDetail: (packageId: string) => void;
  onUninstall: (packageId: string) => void;
}) {
  if (!installedRecords || installedRecords.length === 0) {
    return <div className="store-empty">No installed packages</div>;
  }

  return (
    <div className="store-installed-list">
      {installedRecords.map((rec) => (
        <div
          key={rec.packageId}
          className="store-installed-item"
          onClick={() => onDetail(rec.packageId)}
        >
          <div className="store-installed-info">
            <div className="store-installed-name">{rec.packageId}</div>
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
      ))}
    </div>
  );
}

export default StoreView;
