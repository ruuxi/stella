import { useNavigate } from "@tanstack/react-router";
import { api } from "@/convex/api";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import type { StorePackageRecord } from "@/shared/types/electron";
import type { ParsedShareLink } from "./share-link";
import "./store.css";

type AddonShareCardProps = {
  link: ParsedShareLink;
  /**
   * Width hint controlling whether the card flows wide (timeline rows
   * inside the social full pane) or tight (compact bubble). Defaults to
   * wide. The card is otherwise self-styled — the social bubble drops
   * its padding/background when wrapping the card so the embed becomes
   * the message.
   */
  variant?: "wide" | "compact";
};

/**
 * Embedded preview rendered in social chat when a message body is just
 * a `stella://store/<handle>/<packageId>` link.
 *
 * Resolves the package via `getPublicPackage` (which honours visibility
 * — `public` and `unlisted` resolve, `private` returns null and the
 * card falls back to a "no longer available" placeholder so the link
 * never silently breaks).
 *
 * Click navigates to `/store?package=<id>` which the StoreApp reads as
 * `initialPackageId` and opens the detail view directly.
 */
export function AddonShareCard({ link, variant = "wide" }: AddonShareCardProps) {
  const navigate = useNavigate();
  // One-shot, not a subscription: this card is embedded inside chat
  // bubbles (potentially many per conversation), and a published
  // package's name/description/icon doesn't shift while a user is
  // reading the message.
  const pkg = useConvexOneShot(api.data.store_packages.getPublicPackage, {
    packageId: link.packageId,
  }) as StorePackageRecord | null | undefined;

  // Loading skeleton: matches the resolved card's height so the chat
  // doesn't reflow once the query lands.
  if (pkg === undefined) {
    return (
      <div className="addon-share-card" data-variant={variant} data-loading>
        <div className="addon-share-card-art" />
        <div className="addon-share-card-body">
          <div className="addon-share-card-eyebrow">Stella add-on</div>
          <div className="addon-share-card-line addon-share-card-line--name" />
          <div className="addon-share-card-line addon-share-card-line--desc" />
        </div>
      </div>
    );
  }

  // Resolution failed (private add-on, deleted, or wrong link). Render
  // a muted fallback so the message isn't blank — the user still sees
  // they were sent something, with a hint that it's no longer
  // viewable.
  if (!pkg) {
    return (
      <div className="addon-share-card" data-variant={variant} data-missing>
        <div className="addon-share-card-art addon-share-card-art--missing">?</div>
        <div className="addon-share-card-body">
          <div className="addon-share-card-eyebrow">Stella add-on</div>
          <div className="addon-share-card-name">Add-on unavailable</div>
          <div className="addon-share-card-desc">
            This add-on is private or no longer published.
          </div>
        </div>
      </div>
    );
  }

  const handleOpen = () => {
    void navigate({
      to: "/store",
      search: { tab: "discover", package: pkg.packageId },
    });
  };

  return (
    <button
      type="button"
      className="addon-share-card"
      data-variant={variant}
      onClick={handleOpen}
    >
      {pkg.iconUrl ? (
        <img
          src={pkg.iconUrl}
          alt=""
          className="addon-share-card-art"
          draggable={false}
        />
      ) : (
        <div className="addon-share-card-art addon-share-card-art--letter">
          {(pkg.displayName.trim()[0] ?? "S").toUpperCase()}
        </div>
      )}
      <div className="addon-share-card-body">
        <div className="addon-share-card-eyebrow">Stella add-on</div>
        <div className="addon-share-card-name">{pkg.displayName}</div>
        <div className="addon-share-card-desc">{pkg.description}</div>
        <div className="addon-share-card-meta">
          {pkg.authorUsername ? (
            <span className="addon-share-card-handle">@{pkg.authorUsername}</span>
          ) : (
            <span />
          )}
          <span className="addon-share-card-cta">View →</span>
        </div>
      </div>
    </button>
  );
}
