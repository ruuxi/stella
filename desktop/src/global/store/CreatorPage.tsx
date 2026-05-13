/**
 * Creator page. Lists every public add-on a creator has shared.
 *
 * Reachable via `/c/:username`. Author bylines on add-on cards link
 * here once the creator has a social profile.
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Share2 } from "lucide-react";
import { api } from "@/convex/api";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import type { StorePackageRecord } from "@/shared/types/electron";
import { ShareAddonDialog } from "./ShareAddonDialog";
import "./store.css";

type Props = { username: string };

export function CreatorPage({ username }: Props) {
  const navigate = useNavigate();
  const [sharePkg, setSharePkg] = useState<StorePackageRecord | null>(null);
  // One-shot, not a subscription: visiting a creator's page is
  // read-only browsing — neither the profile nor their published
  // package list will move while the user is on the page.
  const profile = useConvexOneShot(api.social.profiles.getProfileByUsername, {
    username,
  }) as { username: string } | null | undefined;
  const packages = useConvexOneShot(
    api.data.store_packages.listPackagesByAuthorUsername,
    { username },
  ) as StorePackageRecord[] | undefined;

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
            No one has claimed the username <code>@{username}</code> yet.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="store-creator-page">
      <header className="store-creator-header">
        <div className="store-creator-handle">@{profile.username}</div>
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
            @{profile.username} hasn't shared any add-ons yet.
          </div>
        </div>
      ) : (
        <div className="store-grid">
          {packages.map((pkg) => (
            <div
              key={pkg.packageId}
              className="store-card"
              data-clickable="true"
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
                  <div className="store-card-actions">
                    <button
                      type="button"
                      className="store-icon-btn"
                      aria-label="Share add-on"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSharePkg(pkg);
                      }}
                    >
                      <Share2 size={14} />
                    </button>
                  </div>
                </div>
                <div className="store-card-desc">{pkg.description}</div>
                <div className="store-card-meta">
                  Version {pkg.latestReleaseNumber}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {sharePkg ? (
        <ShareAddonDialog
          open
          onOpenChange={(open) => {
            if (!open) setSharePkg(null);
          }}
          pkg={sharePkg}
        />
      ) : null}
    </div>
  );
}
