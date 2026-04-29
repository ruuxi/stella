/**
 * Creator page. Lists every public add-on a creator has shared.
 *
 * Reachable via `/c/:handle`. Author bylines on add-on cards link
 * here once the creator has claimed a handle (via `claimHandle`).
 */
import { useQuery } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/convex/api";
import type { StorePackageRecord } from "@/shared/types/electron";
import "./store.css";

type Props = { handle: string };

export function CreatorPage({ handle }: Props) {
  const navigate = useNavigate();
  const profile = useQuery(api.data.user_profiles.getProfileByHandle, { handle }) as
    | { publicHandle: string; displayName?: string }
    | null
    | undefined;
  const packages = useQuery(api.data.store_packages.listPackagesByAuthorHandle, {
    handle,
  }) as StorePackageRecord[] | undefined;

  if (profile === undefined || packages === undefined) {
    return (
      <div className="store-creator-page">
        <div className="store-creator-loading">Loading creator…</div>
      </div>
    );
  }

  if (profile === null) {
    return (
      <div className="store-creator-page">
        <div className="store-creator-empty">
          <div className="store-creator-empty-title">Creator not found</div>
          <div className="store-creator-empty-body">
            No one has claimed the handle <code>@{handle}</code> yet.
          </div>
        </div>
      </div>
    );
  }

  const displayName = profile.displayName?.trim() || profile.publicHandle;

  return (
    <div className="store-creator-page">
      <header className="store-creator-header">
        <div className="store-creator-handle">@{profile.publicHandle}</div>
        <div className="store-creator-display-name">{displayName}</div>
        <div className="store-creator-count">
          {packages.length === 0
            ? "No add-ons yet"
            : packages.length === 1
              ? "1 add-on"
              : `${packages.length} add-ons`}
        </div>
      </header>

      {packages.length === 0 ? (
        <div className="store-creator-empty">
          <div className="store-creator-empty-body">
            {displayName} hasn't shared any add-ons yet.
          </div>
        </div>
      ) : (
        <div className="store-grid">
          {packages.map((pkg) => (
            <button
              type="button"
              key={pkg.packageId}
              className="store-card"
              onClick={() =>
                void navigate({
                  to: "/store",
                  search: { tab: "discover", package: pkg.packageId },
                })
              }
            >
              <div className="store-card-body">
                <div className="store-card-top">
                  <span className="store-card-name">{pkg.displayName}</span>
                </div>
                <div className="store-card-desc">{pkg.description}</div>
                <div className="store-card-meta">
                  Version {pkg.latestReleaseNumber}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default CreatorPage;
