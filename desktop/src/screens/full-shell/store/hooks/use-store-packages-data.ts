/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import type {
  CategoryTab,
  InstalledRecord,
  StorePackage,
  StoreUpdatePackage,
} from "../constants";

interface UseStorePackagesDataOptions {
  category: CategoryTab;
  searchQuery: string;
  selectedPackageId: string | null;
}

export function useStorePackagesData({
  category,
  searchQuery,
  selectedPackageId,
}: UseStorePackagesDataOptions) {
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
  ) as InstalledRecord[] | undefined;

  const selectedPackage = useQuery(
    api.data.store_packages.getByPackageId as any,
    selectedPackageId ? { packageId: selectedPackageId } : "skip",
  ) as StorePackage | null | undefined;

  const allPackages = useQuery(
    api.data.store_packages.list as any,
    { type: undefined },
  ) as StorePackage[] | undefined;

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
      .filter((value): value is StoreUpdatePackage => Boolean(value));
  }, [installedRecords, packageLookup]);

  const featured = useMemo(() => {
    if (!allPackages || allPackages.length === 0) return null;
    return [...allPackages].sort((a, b) => (b.downloads || 0) - (a.downloads || 0))[0];
  }, [allPackages]);

  const gridPackages = useMemo(() => {
    if (!packages) return packages;
    if (searchQuery || !featured) return packages;
    return packages.filter((pkg) => pkg.packageId !== featured.packageId);
  }, [packages, featured, searchQuery]);

  const totalPackageCount = allPackages?.length ?? 0;
  const installedCount = installedRecords?.length ?? 0;

  return {
    installedRecords,
    selectedPackage,
    packageLookup,
    updates,
    featured,
    gridPackages,
    installedSet,
    totalPackageCount,
    installedCount,
  };
}
