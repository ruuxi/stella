import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compass, MoreHorizontal, Search, User } from "lucide-react";
import { Button } from "@/ui/button";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import { showToast } from "@/ui/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  useActiveEmojiPack,
  type ActiveEmojiPack,
} from "@/app/chat/emoji-sprites/active-emoji-pack";
import {
  emojiPackToActivePack,
  useEmojiPackTagFacets,
  useEmojiPackMutations,
  useMyEmojiPacks,
  usePublicEmojiPacks,
  type EmojiPackSort,
  type EmojiPackRecord,
  type EmojiPackVisibility,
} from "./emoji-pack-data";
import { CreateEmojiPackDialog } from "./CreateEmojiPackDialog";
import { ShareEmojiPackDialog } from "./ShareEmojiPackDialog";
import { EmojiPackDetailsDialog } from "./EmojiPackDetailsDialog";
import "./emojis.css";

const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 200;
const ALL_TAG = "all" as const;
const SORT_LABELS: Record<EmojiPackSort, string> = {
  installs: "Most used",
  name: "Alphabetical",
};

const formatInstallCount = (count: number | undefined): string => {
  const n = count ?? 0;
  if (n <= 0) return "New";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M uses`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K uses`;
  return `${n} use${n === 1 ? "" : "s"}`;
};

type PackCardProps = {
  pack: EmojiPackRecord;
  active: boolean;
  owned: boolean;
  onOpen: () => void;
  onSetVisibility: (next: EmojiPackVisibility) => void;
  onShare: () => void;
  onDelete: () => void;
};

function PackCard({
  pack,
  active,
  owned,
  onOpen,
  onSetVisibility,
  onShare,
  onDelete,
}: PackCardProps) {
  const author =
    pack.authorDisplayName?.trim() ||
    (pack.authorHandle ? `@${pack.authorHandle}` : "Unknown");
  return (
    <div className="emoji-pack-card" data-active={active || undefined}>
      <button
        type="button"
        className="emoji-pack-cover"
        onClick={onOpen}
        aria-label={`Open ${pack.displayName}`}
      >
        {pack.coverUrl ? (
          <img
            src={pack.coverUrl}
            alt=""
            width={56}
            height={56}
            className="emoji-pack-cover-img"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="emoji-pack-cover-glyph" aria-hidden>
            {pack.coverEmoji}
          </span>
        )}
      </button>
      <div className="emoji-pack-body">
        <div className="emoji-pack-name-row">
          <span className="emoji-pack-name">{pack.displayName}</span>
          {owned && pack.visibility !== "public" ? (
            <span
              className="emoji-pack-visibility-badge"
              data-tier={pack.visibility}
            >
              {pack.visibility === "private" ? "Private" : "Unlisted"}
            </span>
          ) : null}
        </div>
        {pack.description ? (
          <span className="emoji-pack-desc">{pack.description}</span>
        ) : null}
        <div className="emoji-pack-meta">
          <span className="emoji-pack-author">by {author}</span>
          <span className="emoji-pack-installs">
            {formatInstallCount(pack.installCount)}
          </span>
        </div>
      </div>
      <div className="emoji-pack-actions">
        <Button
          type="button"
          variant={active ? "secondary" : "primary"}
          size="small"
          className={
            active ? "pill-btn" : "pill-btn pill-btn--primary"
          }
          onClick={onOpen}
        >
          {active ? "Active" : "Get"}
        </Button>
        {owned ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="emoji-pack-menu-btn"
                aria-label={`More actions for ${pack.displayName}`}
              >
                <MoreHorizontal size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="store-card-menu">
              <DropdownMenuLabel>Visibility</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={pack.visibility}
                onValueChange={(value) => {
                  if (
                    value === "public" ||
                    value === "unlisted" ||
                    value === "private"
                  ) {
                    onSetVisibility(value);
                  }
                }}
              >
                <DropdownMenuRadioItem value="public">
                  <div className="store-card-menu-item-text">
                    <span className="store-card-menu-item-title">Public</span>
                    <span className="store-card-menu-item-sub">
                      Listed on the Store
                    </span>
                  </div>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="unlisted">
                  <div className="store-card-menu-item-text">
                    <span className="store-card-menu-item-title">Unlisted</span>
                    <span className="store-card-menu-item-sub">
                      Anyone with the link
                    </span>
                  </div>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="private">
                  <div className="store-card-menu-item-text">
                    <span className="store-card-menu-item-title">Private</span>
                    <span className="store-card-menu-item-sub">Only you</span>
                  </div>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onShare()}>
                Share with friends
              </DropdownMenuItem>
              <DropdownMenuItem
                data-variant="destructive"
                onSelect={() => {
                  const ok = window.confirm(
                    `Delete "${pack.displayName}"? This cannot be undone.`,
                  );
                  if (ok) onDelete();
                }}
              >
                Delete pack
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

export function EmojiStorePage() {
  const { hasConnectedAccount } = useAuthSessionState();
  const [activePack, setActivePack] = useActiveEmojiPack();
  const [createOpen, setCreateOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<EmojiPackRecord | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<EmojiPackRecord | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string>(ALL_TAG);
  const [sort, setSort] = useState<EmojiPackSort>("installs");
  const [viewMode, setViewMode] = useState<"discover" | "mine">("discover");
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  const myPacks = useMyEmojiPacks(hasConnectedAccount);
  const {
    results: publicPacks,
    status,
    loadMore,
  } = usePublicEmojiPacks({
    search: debouncedQuery,
    sort,
    tag:
      debouncedQuery.trim().length === 0 && activeTag !== ALL_TAG
        ? activeTag
        : undefined,
  });
  const tagFacets = useEmojiPackTagFacets();

  const { setVisibility, deletePack, recordInstall } = useEmojiPackMutations();

  const ownedPackIds = useMemo(() => {
    const set = new Set<string>();
    for (const pack of myPacks ?? []) set.add(pack.packId);
    return set;
  }, [myPacks]);

  const visiblePublicPacks = useMemo(
    () => publicPacks.filter((pack) => !ownedPackIds.has(pack.packId)),
    [ownedPackIds, publicPacks],
  );

  const canLoadMore = status === "CanLoadMore";
  const isLoadingMore = status === "LoadingMore";
  const isLoadingFirstPage = status === "LoadingFirstPage";
  const tagOptions = useMemo(
    () => (tagFacets ?? []).map((facet) => facet.tag),
    [tagFacets],
  );

  // Auto-load the next page as the sentinel approaches the viewport.
  useEffect(() => {
    if (!canLoadMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMore(PAGE_SIZE);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [canLoadMore, loadMore]);

  // Track packs we've already counted in this session so reusing a
  // pack a few times doesn't keep hammering the install counter (the
  // backend rate limit also enforces this; skipping the trip is just
  // snappier).
  const recordedRef = useRef<Set<string>>(new Set());

  const handleUse = useCallback(
    async (pack: EmojiPackRecord) => {
      if (!hasConnectedAccount) {
        showToast({
          title: "Sign in to use emoji packs",
          variant: "error",
        });
        return;
      }
      if (!recordedRef.current.has(pack.packId)) {
        recordedRef.current.add(pack.packId);
        try {
          await recordInstall({ packId: pack.packId });
        } catch (err) {
          recordedRef.current.delete(pack.packId);
          throw err;
        }
      }
      const next: ActiveEmojiPack = emojiPackToActivePack(pack);
      setActivePack(next);
    },
    [hasConnectedAccount, recordInstall, setActivePack],
  );

  const handleDeactivate = useCallback(() => {
    setActivePack(null);
  }, [setActivePack]);

  const handleSetVisibility = useCallback(
    async (pack: EmojiPackRecord, next: EmojiPackVisibility) => {
      try {
        await setVisibility({ packId: pack.packId, visibility: next });
        showToast({
          title:
            next === "public"
              ? "Listed on the Store"
              : next === "unlisted"
              ? "Unlisted (link only)"
              : "Hidden from everyone",
          variant: "success",
        });
      } catch (err) {
        showToast({
          title:
            err instanceof Error ? err.message : "Couldn't update visibility",
          variant: "error",
        });
      }
    },
    [setVisibility],
  );

  const handleDelete = useCallback(
    async (pack: EmojiPackRecord) => {
      try {
        await deletePack({ packId: pack.packId });
        if (activePack?.packId === pack.packId) {
          setActivePack(null);
        }
        showToast({ title: "Pack deleted", variant: "success" });
      } catch (err) {
        showToast({
          title: err instanceof Error ? err.message : "Couldn't delete pack",
          variant: "error",
        });
      }
    },
    [activePack, deletePack, setActivePack],
  );

  return (
    <main className="emoji-page">
      <header className="emoji-page-header">
        <div className="emoji-page-heading">
          <h1 className="emoji-page-title">Emoji packs</h1>
          {activePack ? (
            <span className="emoji-page-active">
              Using{" "}
              <button
                type="button"
                className="emoji-page-active-clear"
                onClick={handleDeactivate}
              >
                stop
              </button>
            </span>
          ) : null}
        </div>
        <p className="emoji-page-subtitle">
          Describe a vibe — Stella generates 108 custom emojis across three
          sheets. Pick a pack to swap the standard emojis in chat. Switch any
          time.
        </p>
      </header>

      <div className="emoji-page-toolbar">
        <label className="emoji-page-search">
          <Search size={14} className="emoji-page-search-icon" aria-hidden />
          <input
            type="search"
            className="emoji-page-search-input"
            placeholder="Search public packs"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            spellCheck={false}
          />
        </label>
        <label className="emoji-page-sort">
          <span className="emoji-page-sort-label">Sort</span>
          <select
            className="emoji-page-sort-select"
            value={sort}
            onChange={(event) => setSort(event.currentTarget.value as EmojiPackSort)}
          >
            {(Object.keys(SORT_LABELS) as EmojiPackSort[]).map((option) => (
              <option key={option} value={option}>
                {SORT_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <div className="emoji-page-toolbar-actions">
          <Button
            variant="secondary"
            size="normal"
            className="pill-btn pill-btn--lg"
            onClick={() => {
              if (viewMode === "mine") {
                setViewMode("discover");
                return;
              }
              if (!hasConnectedAccount) {
                showToast({
                  title: "Sign in to see your emoji packs",
                  variant: "error",
                });
                return;
              }
              setViewMode("mine");
            }}
          >
            {viewMode === "mine" ? (
              <>
                <Compass size={14} aria-hidden />
                Discover
              </>
            ) : (
              <>
                <User size={14} aria-hidden />
                My emojis
              </>
            )}
          </Button>
          <Button
            variant="primary"
            size="normal"
            className="pill-btn pill-btn--primary pill-btn--lg"
            style={{
              borderColor:
                "color-mix(in oklch, var(--primary-foreground) 30%, transparent)",
            }}
            onClick={() => {
              if (!hasConnectedAccount) {
                showToast({
                  title: "Sign in to create your own emoji pack",
                  variant: "error",
                });
                return;
              }
              setCreateOpen(true);
            }}
          >
            <StellaLogoIcon size={14} aria-hidden />
            Create pack
          </Button>
        </div>
      </div>

      {viewMode === "discover" ? (
        <>
          <div className="emoji-page-tags" role="tablist" aria-label="Filter emoji packs by tag">
            <button
              type="button"
              role="tab"
              className="emoji-page-tag-pill"
              data-active={activeTag === ALL_TAG ? "true" : "false"}
              aria-selected={activeTag === ALL_TAG}
              onClick={() => setActiveTag(ALL_TAG)}
            >
              All
            </button>
            {tagOptions.map((tag) => (
              <button
                key={tag}
                type="button"
                role="tab"
                className="emoji-page-tag-pill"
                data-active={activeTag === tag ? "true" : "false"}
                aria-selected={activeTag === tag}
                onClick={() => setActiveTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>

          {myPacks && myPacks.length > 0 ? (
            <section className="emoji-page-section">
              <div className="emoji-page-section-header">
                <span className="emoji-page-section-title">Your packs</span>
                <span className="emoji-page-section-count">{myPacks.length}</span>
              </div>
              <div className="emoji-pack-grid">
                {myPacks.map((pack) => (
                  <PackCard
                    key={pack.packId}
                    pack={pack}
                    active={activePack?.packId === pack.packId}
                    owned
                    onOpen={() => setDetailsTarget(pack)}
                    onSetVisibility={(next) =>
                      void handleSetVisibility(pack, next)
                    }
                    onShare={() => setShareTarget(pack)}
                    onDelete={() => void handleDelete(pack)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="emoji-page-section">
            <div className="emoji-page-section-header">
              <span className="emoji-page-section-title">Discover</span>
              {visiblePublicPacks.length > 0 ? (
                <span className="emoji-page-section-count">
                  {visiblePublicPacks.length}
                  {canLoadMore ? "+" : ""}
                </span>
              ) : null}
            </div>
            {isLoadingFirstPage ? (
              <div className="emoji-page-empty">Loading…</div>
            ) : visiblePublicPacks.length === 0 ? (
              <div className="emoji-page-empty">
                {debouncedQuery.trim()
                  ? "No packs match that search."
                  : "No community packs yet — be the first to make one."}
              </div>
            ) : (
              <div className="emoji-pack-grid">
                {visiblePublicPacks.map((pack) => (
                  <PackCard
                    key={pack.packId}
                    pack={pack}
                    active={activePack?.packId === pack.packId}
                    owned={false}
                    onOpen={() => setDetailsTarget(pack)}
                    onSetVisibility={() => undefined}
                    onShare={() => setShareTarget(pack)}
                    onDelete={() => undefined}
                  />
                ))}
              </div>
            )}
            {canLoadMore || isLoadingMore ? (
              <div
                ref={sentinelRef}
                className="emoji-page-sentinel"
                data-loading={isLoadingMore || undefined}
              >
                {isLoadingMore ? "Loading more…" : ""}
              </div>
            ) : null}
          </section>
        </>
      ) : (
        <section className="emoji-page-section">
          <div className="emoji-page-section-header">
            <span className="emoji-page-section-title">My emojis</span>
            {myPacks && myPacks.length > 0 ? (
              <span className="emoji-page-section-count">{myPacks.length}</span>
            ) : null}
          </div>
          {!myPacks ? (
            <div className="emoji-page-empty">Loading…</div>
          ) : myPacks.length === 0 ? (
            <div className="emoji-page-empty">
              You haven't created any emoji packs yet.
            </div>
          ) : (
            <div className="emoji-pack-grid">
              {myPacks.map((pack) => (
                <PackCard
                  key={pack.packId}
                  pack={pack}
                  active={activePack?.packId === pack.packId}
                  owned
                  onOpen={() => setDetailsTarget(pack)}
                  onSetVisibility={(next) =>
                    void handleSetVisibility(pack, next)
                  }
                  onShare={() => setShareTarget(pack)}
                  onDelete={() => void handleDelete(pack)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {detailsTarget ? (
        <EmojiPackDetailsDialog
          open
          onOpenChange={(next) => {
            if (!next) setDetailsTarget(null);
          }}
          pack={detailsTarget}
          active={activePack?.packId === detailsTarget.packId}
          hasConnectedAccount={hasConnectedAccount}
          onUse={async (pack) => {
            await handleUse(pack);
          }}
          onStop={() => {
            handleDeactivate();
            setDetailsTarget(null);
          }}
        />
      ) : null}

      {hasConnectedAccount ? (
        <CreateEmojiPackDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
      {shareTarget ? (
        <ShareEmojiPackDialog
          open
          onOpenChange={(next) => {
            if (!next) setShareTarget(null);
          }}
          pack={shareTarget}
        />
      ) : null}
    </main>
  );
}

export default EmojiStorePage;
