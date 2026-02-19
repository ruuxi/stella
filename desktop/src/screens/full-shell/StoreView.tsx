import { useCallback, useState } from "react";
import { FeaturedHero } from "./store/components/FeaturedHero";
import { InstalledList } from "./store/components/InstalledList";
import { PackageCard } from "./store/components/PackageCard";
import { PackageDetail } from "./store/components/PackageDetail";
import { StoreHeader } from "./store/components/StoreHeader";
import { UpdatesList } from "./store/components/UpdatesList";
import {
  CATEGORY_TABS,
  type CategoryTab,
  type StorePage,
  type StoreViewProps,
} from "./store/constants";
import { useStoreInstallationActions } from "./store/hooks/use-store-installation-actions";
import { useStorePackagesData } from "./store/hooks/use-store-packages-data";

function StoreView({ onComposePrompt }: StoreViewProps) {
  const [page, setPage] = useState<StorePage>("browse");
  const [category, setCategory] = useState<CategoryTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);

  const {
    installedRecords,
    selectedPackage,
    packageLookup,
    updates,
    featured,
    gridPackages,
    installedSet,
    totalPackageCount,
    installedCount,
  } = useStorePackagesData({
    category,
    searchQuery,
    selectedPackageId,
  });

  const { installingIds, handleInstall, handleUninstall } = useStoreInstallationActions({
    onComposePrompt,
  });

  const openDetail = useCallback((packageId: string) => {
    setSelectedPackageId(packageId);
    setPage("detail");
  }, []);

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
          onBack={() => {
            setPage("browse");
            setSelectedPackageId(null);
          }}
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

export default StoreView;
