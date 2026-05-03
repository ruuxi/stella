import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, Search, Sparkles } from "lucide-react";
import { Button } from "@/ui/button";
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
import { EMOJI_SHEETS } from "@/app/chat/emoji-sprites/cells";
import {
  emojiPackToActivePack,
  useEmojiPackMutations,
  useMyEmojiPacks,
  usePublicEmojiPacks,
  type EmojiPackRecord,
  type EmojiPackVisibility,
} from "./emoji-pack-data";
import { CreateEmojiPackDialog } from "./CreateEmojiPackDialog";
import { ShareEmojiPackDialog } from "./ShareEmojiPackDialog";
import { EmojiCellPreview } from "./EmojiCellPreview";
import "./emojis.css";

const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 200;

const formatInstallCount = (count: number | undefined): string => {
  const n = count ?? 0;
  if (n <= 0) return "New";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M uses`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K uses`;
  return `${n} use${n === 1 ? "" : "s"}`;
};

/**
 * Pick the right sheet URL for a pack's cover cell. We always store
 * the cover glyph as the literal emoji string, but the cell index has
 * to be re-derived against the same emoji ordering the renderer uses.
 */
const findCoverCell = (
  pack: EmojiPackRecord,
): { sheetUrl: string; cell: number } => {
  const sheets = [pack.sheet1Url, pack.sheet2Url];
  const glyph = pack.coverEmoji;
  for (let s = 0; s < sheets.length; s += 1) {
    const list = EMOJI_SHEETS[s];
    if (!list) continue;
    const idx = list.indexOf(glyph);
    if (idx !== -1) {
      return { sheetUrl: sheets[s] ?? sheets[0]!, cell: idx };
    }
  }
  return { sheetUrl: pack.sheet1Url, cell: 0 };
};

type PackCardProps = {
  pack: EmojiPackRecord;
  active: boolean;
  owned: boolean;
  onUse: () => void;
  onDeactivate: () => void;
  onSetVisibility: (next: EmojiPackVisibility) => void;
  onShare: () => void;
  onDelete: () => void;
};

function PackCard({
  pack,
  active,
  owned,
  onUse,
  onDeactivate,
  onSetVisibility,
  onShare,
  onDelete,
}: PackCardProps) {
  const cover = useMemo(() => findCoverCell(pack), [pack]);
  const author =
    pack.authorDisplayName?.trim() ||
    (pack.authorHandle ? `@${pack.authorHandle}` : "Unknown");
  return (
    <div className="emoji-pack-card" data-active={active || undefined}>
      <button
        type="button"
        className="emoji-pack-cover"
        onClick={active ? onDeactivate : onUse}
        aria-label={active ? `Stop using ${pack.displayName}` : `Use ${pack.displayName}`}
        data-stella-action="select-emoji-pack"
        data-stella-label={pack.displayName}
        data-stella-state={active ? "active" : "available"}
      >
        <EmojiCellPreview
          sheetUrl={cover.sheetUrl}
          cell={cover.cell}
          size={56}
        />
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
          className="pill-btn"
          onClick={active ? onDeactivate : onUse}
        >
          {active ? "Active" : "Use"}
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
              <DropdownMenuLabel className="store-card-menu-label">
                Visibility
              </DropdownMenuLabel>
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
                <DropdownMenuRadioItem value="public" className="store-card-menu-item">
                  <div className="store-card-menu-item-text">
                    <span className="store-card-menu-item-title">Public</span>
                    <span className="store-card-menu-item-sub">
                      Listed on the Store
                    </span>
                  </div>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="unlisted" className="store-card-menu-item">
                  <div className="store-card-menu-item-text">
                    <span className="store-card-menu-item-title">Unlisted</span>
                    <span className="store-card-menu-item-sub">
                      Anyone with the link
                    </span>
                  </div>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="private" className="store-card-menu-item">
                  <div className="store-card-menu-item-text">
                    <span className="store-card-menu-item-title">Private</span>
                    <span className="store-card-menu-item-sub">Only you</span>
                  </div>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator className="store-card-menu-separator" />
              <DropdownMenuItem
                className="store-card-menu-item"
                onSelect={() => onShare()}
              >
                Share with friends
              </DropdownMenuItem>
              <DropdownMenuItem
                className="store-card-menu-item store-card-menu-item--danger"
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
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
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
  } = usePublicEmojiPacks(debouncedQuery);

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
    (pack: EmojiPackRecord) => {
      const next: ActiveEmojiPack = emojiPackToActivePack(pack);
      setActivePack(next);
      if (!recordedRef.current.has(pack.packId)) {
        recordedRef.current.add(pack.packId);
        void recordInstall({ packId: pack.packId }).catch(() => {
          recordedRef.current.delete(pack.packId);
        });
      }
    },
    [recordInstall, setActivePack],
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

  if (!hasConnectedAccount) {
    return (
      <main className="emoji-page" data-stella-section="emojis">
        <header className="emoji-page-header">
          <h1 className="emoji-page-title">Emoji packs</h1>
          <p className="emoji-page-subtitle">
            Replace standard emojis in chat with a custom AI-generated pack.
          </p>
        </header>
        <div className="emoji-page-signin">
          <p>Sign in to create and share emoji packs.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="emoji-page" data-stella-section="emojis">
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
          Describe a vibe — Stella generates 128 custom emojis (two sheets of
          64). Pick a pack to swap the standard emojis in chat. Switch any
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
        <Button
          variant="primary"
          size="normal"
          className="pill-btn pill-btn--primary"
          onClick={() => setCreateOpen(true)}
        >
          <Sparkles size={14} />
          Create pack
        </Button>
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
                onUse={() => handleUse(pack)}
                onDeactivate={handleDeactivate}
                onSetVisibility={(next) => void handleSetVisibility(pack, next)}
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
                onUse={() => handleUse(pack)}
                onDeactivate={handleDeactivate}
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

      <CreateEmojiPackDialog open={createOpen} onOpenChange={setCreateOpen} />
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
