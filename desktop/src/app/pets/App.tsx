import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Compass,
  Download,
  MoreHorizontal,
  Plus,
  Search,
  User,
} from "lucide-react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { showToast } from "@/ui/toast";
import { PetIdlePreview } from "./PetIdlePreview";
import { useInstalledPets, isBundledPetId } from "./installed-pets";
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
import { PetSprite } from "@/shell/pet/PetSprite";
import {
  DEFAULT_PET_ID,
  normalizePet,
  type BuiltInPet,
} from "@/shell/pet/built-in-pets";
import { BUNDLED_PETS } from "@/shell/pet/bundled-pets";
import { useTagFacets } from "@/shell/pet/pet-catalog-context";
import {
  getCachedPetCatalogFirstPage,
  writeCachedPetById,
  writeCachedPetCatalogFirstPage,
} from "@/shell/pet/pet-catalog-cache";
import {
  readPetOpenPreference,
  useSelectedPetId,
  writePetOpenPreference,
} from "@/shell/pet/pet-preferences";
import type { PetAnimationState } from "@/shared/contracts/pet";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { CreatePetDialog } from "./CreatePetDialog";
import { SharePetDialog } from "./SharePetDialog";
import {
  useMyUserPets,
  usePublicUserPets,
  useUserPetMutations,
  type UserPetRecord,
  type UserPetVisibility,
} from "./user-pet-data";
import "./pets.css";

const ALL_TAG = "all" as const;
/** Initial page request to Convex. Subsequent `loadMore(PAGE_SIZE)` calls
 *  are driven by the IntersectionObserver as the user scrolls. */
const PAGE_SIZE = 32;
/** Debounce window before the search input becomes a query argument. We
 *  don't want every keystroke to spawn a fresh Convex subscription. */
const SEARCH_DEBOUNCE_MS = 200;

type SortOption = "downloads" | "name";

const SORT_LABELS: Record<SortOption, string> = {
  downloads: "Most popular",
  name: "Alphabetical",
};

const ANIMATION_STATES: ReadonlyArray<{
  state: PetAnimationState;
  label: string;
}> = [
  { state: "idle", label: "Idle" },
  { state: "running-right", label: "Run right" },
  { state: "running-left", label: "Run left" },
  { state: "waving", label: "Waving" },
  { state: "jumping", label: "Jumping" },
  { state: "failed", label: "Failed" },
  { state: "waiting", label: "Waiting" },
  { state: "running", label: "Running" },
  { state: "review", label: "Review" },
];

const downloadCountFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

const formatDownloads = (value: number): string =>
  downloadCountFormatter.format(Math.max(0, Math.floor(value)));

/**
 * Bundled pets ship with the desktop app and aren't in Convex; surface
 * them as if they were the very first results so the picker is never
 * empty even before the first network round trip. They're filtered
 * client-side against the active tag/search/sort because the bundled
 * set is single-digit-small.
 */
const filterBundledPets = (
  tag: string,
  search: string,
  sort: SortOption,
): BuiltInPet[] => {
  const trimmed = search.trim().toLowerCase();
  const filtered = BUNDLED_PETS.filter((pet) => {
    if (tag !== ALL_TAG && !pet.tags.includes(tag)) return false;
    if (!trimmed) return true;
    return (
      pet.displayName.toLowerCase().includes(trimmed) ||
      pet.description.toLowerCase().includes(trimmed) ||
      pet.creator.toLowerCase().includes(trimmed)
    );
  });
  if (sort === "downloads") {
    filtered.sort((a, b) => {
      if (b.downloads !== a.downloads) return b.downloads - a.downloads;
      return a.displayName.localeCompare(b.displayName);
    });
  } else {
    filtered.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return filtered;
};

type PetCardActionState = "uninstalled" | "installed" | "selected";

type PetCardProps = {
  pet: BuiltInPet;
  state: PetCardActionState;
  removable: boolean;
  /** True when this card is rendering one of our own user-generated
   *  pets, where `previewUrl` is the 8-frame `PREVIEW_STRIP` we built
   *  in the renderer. Upstream catalog pets ship a different preview
   *  shape (full atlas linearized into a wide strip) so we must always
   *  use `PetSprite` for them — passing the upstream preview into
   *  `PetIdlePreview` shows ~9 frames at once. */
  ownIdleStrip?: boolean;
  badge?: { label: string; tier: "private" | "unlisted" } | null;
  menu?: React.ReactNode;
  onOpen: () => void;
  onGet: () => Promise<void> | void;
  onSelect: () => void;
  onRemove: () => void;
};

/**
 * Pets store card. Two key behaviors:
 *
 * 1. Image loading is gated by install state: uninstalled cards only
 *    fetch the tiny `previewUrl` (or render a static silhouette when
 *    one isn't available). The full atlas is loaded by `PetSprite`
 *    only after the user clicks "Get" / "Select".
 * 2. Actions are explicit: Get → Select → Remove rather than the
 *    previous "click to switch immediately" model.
 */
function PetCard({
  pet,
  state,
  removable,
  ownIdleStrip = false,
  badge,
  menu,
  onOpen,
  onGet,
  onSelect,
  onRemove,
}: PetCardProps) {
  // Use the lightweight 8-frame strip only for our own user-generated
  // pets (where `previewUrl` matches `PREVIEW_STRIP`). Everything else
  // (bundled + upstream catalog) animates the full sprite atlas via
  // `PetSprite` — upstream `previewUrl` is a 5472×104 multi-row strip
  // that doesn't fit the 8-frame layout.
  const useIdleStrip = ownIdleStrip && Boolean(pet.previewUrl);
  const animateFull = !useIdleStrip;

  return (
    <div
      className="pets-card pets-card-wrapper"
      data-pet-state={state}
      data-selected={state === "selected" ? "true" : "false"}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="pets-card-sprite">
        {animateFull ? (
          <PetSprite
            spritesheetUrl={pet.spritesheetUrl}
            state="idle"
            size={84}
          />
        ) : useIdleStrip ? (
          <PetIdlePreview previewUrl={pet.previewUrl!} size={84} />
        ) : (
          <div className="pets-card-sprite-placeholder" aria-hidden>
            <StellaLogoIcon size={20} aria-hidden />
          </div>
        )}
      </div>
      <div className="pets-card-name-row">
        <span className="pets-card-name">{pet.displayName}</span>
        {badge ? (
          <span className="pets-card-visibility-badge" data-tier={badge.tier}>
            {badge.label}
          </span>
        ) : null}
      </div>
      <div className="pets-card-meta">
        <span className="pets-card-creator">by {pet.creator}</span>
        <span
          className="pets-card-downloads"
          title={`${pet.downloads.toLocaleString()} selections`}
        >
          <Download size={11} aria-hidden="true" />
          {formatDownloads(pet.downloads)}
        </span>
      </div>
      <div
        className="pets-card-actions"
        onClick={(event) => event.stopPropagation()}
      >
        {state === "uninstalled" ? (
          <Button
            type="button"
            variant="primary"
            size="small"
            className="pill-btn pill-btn--primary"
            onClick={onGet}
          >
            <Plus size={12} />
            Get
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant={state === "selected" ? "secondary" : "primary"}
              size="small"
              className={
                state === "selected" ? "pill-btn" : "pill-btn pill-btn--primary"
              }
              onClick={state === "selected" ? undefined : onSelect}
              disabled={state === "selected"}
            >
              {state === "selected" ? "Selected" : "Select"}
            </Button>
            {removable ? (
              <Button
                type="button"
                variant="secondary"
                size="small"
                className="pill-btn"
                onClick={onRemove}
              >
                Remove
              </Button>
            ) : null}
          </>
        )}
      </div>
      {menu}
    </div>
  );
}

type PetDetailsDialogProps = {
  pet: BuiltInPet;
  state: PetCardActionState;
  removable: boolean;
  onOpenChange: (open: boolean) => void;
  onGet: () => Promise<void> | void;
  onSelect: () => void;
  onRemove: () => void;
};

function PetDetailsDialog({
  pet,
  state,
  removable,
  onOpenChange,
  onGet,
  onSelect,
  onRemove,
}: PetDetailsDialogProps) {
  const [mainState, setMainState] = useState<PetAnimationState>("idle");

  useEffect(() => {
    setMainState("idle");
  }, [pet.id]);

  const primaryLabel =
    state === "selected" ? "Selected" : state === "installed" ? "Select" : "Get";

  const handlePrimary = async () => {
    if (state === "selected") return;
    if (state === "installed") {
      onSelect();
      onOpenChange(false);
      return;
    }
    await onGet();
  };

  const blurb = pet.description?.trim();

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent fit className="pet-detail-dialog">
        <DialogCloseButton />
        <DialogHeader>
          <DialogTitle className="pet-detail-title">
            {pet.displayName}
          </DialogTitle>
          <p className="pet-detail-caption">
            by {pet.creator} · {formatDownloads(pet.downloads)} selections
          </p>
        </DialogHeader>
        <DialogBody className="pet-detail-body">
          <div
            className="pet-detail-stage"
            aria-label={`${pet.displayName} preview`}
          >
            <PetSprite
              spritesheetUrl={pet.spritesheetUrl}
              state={mainState}
              size={220}
              continuous
            />
          </div>

          {blurb ? <p className="pet-detail-blurb">{blurb}</p> : null}

          <div className="pet-detail-actions">
            <Button
              type="button"
              variant={state === "selected" ? "secondary" : "primary"}
              size="normal"
              className={
                state === "selected"
                  ? "pill-btn pill-btn--lg"
                  : "pill-btn pill-btn--primary pill-btn--lg"
              }
              onClick={() => void handlePrimary()}
              disabled={state === "selected"}
            >
              {primaryLabel}
            </Button>
            {removable && state !== "uninstalled" ? (
              <Button
                type="button"
                variant="secondary"
                size="normal"
                className="pill-btn pill-btn--lg"
                onClick={() => {
                  onRemove();
                  onOpenChange(false);
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>

          <section className="pet-detail-states-section">
            <span className="pet-detail-states-label">Animations</span>
            <div
              className="pet-detail-states"
              role="tablist"
              aria-label="Animation states"
            >
              {ANIMATION_STATES.map((entry) => (
                <button
                  key={entry.state}
                  type="button"
                  role="tab"
                  aria-selected={mainState === entry.state}
                  aria-label={entry.label}
                  title={entry.label}
                  className="pet-detail-state-thumb"
                  data-active={mainState === entry.state || undefined}
                  onClick={() => setMainState(entry.state)}
                >
                  <PetSprite
                    spritesheetUrl={pet.spritesheetUrl}
                    state={entry.state}
                    size={52}
                    continuous
                  />
                </button>
              ))}
            </div>
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

const userPetToBuiltIn = (pet: UserPetRecord): BuiltInPet => ({
  id: pet.petId,
  displayName: pet.displayName,
  description: pet.description,
  kind: "custom",
  tags: ["custom"],
  ownerName: pet.authorUsername ? `@${pet.authorUsername}` : null,
  spritesheetUrl: pet.spritesheetUrl,
  ...(pet.previewUrl ? { previewUrl: pet.previewUrl } : {}),
  sourceUrl: "",
  creator: pet.authorUsername ? `@${pet.authorUsername}` : "You",
  downloads: pet.installCount ?? 0,
});

export const PetsApp = () => {
  const incrementDownloads = useMutation(api.data.pets.incrementDownloads);
  const { hasConnectedAccount } = useAuthSessionState();
  const [selectedPetId, setSelectedPetId] = useSelectedPetId(DEFAULT_PET_ID);
  const [activeTag, setActiveTag] = useState<string>(ALL_TAG);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<SortOption>("downloads");
  const [petOpen, setPetOpenState] = useState<boolean>(() =>
    readPetOpenPreference(),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<UserPetRecord | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<BuiltInPet | null>(null);
  const [viewMode, setViewMode] = useState<"discover" | "mine">("discover");
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const myUserPets = useMyUserPets(hasConnectedAccount);
  const { results: publicUserPets } = usePublicUserPets(debouncedQuery);
  const {
    setVisibility: setUserPetVisibility,
    deletePet: deleteUserPet,
    recordInstall: recordUserPetInstall,
  } = useUserPetMutations();

  const ownedUserPetIds = useMemo(() => {
    const set = new Set<string>();
    for (const pet of myUserPets ?? []) set.add(pet.petId);
    return set;
  }, [myUserPets]);
  /** Tracks pets we've already incremented in this session so repeated
   *  clicks don't keep inflating the public counter (the backend rate
   *  limit also enforces this, but skipping the round-trip is snappier). */
  const incrementedRef = useRef<Set<string>>(new Set());
  /** First page rendered immediately from localStorage so a cold start
   *  isn't blank for the duration of the first Convex round trip. */
  const cachedFirstPageRef = useRef<BuiltInPet[]>(getCachedPetCatalogFirstPage());

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    const cleanup = window.electronAPI?.pet?.onSetOpen?.((open) => {
      setPetOpenState(open);
    });
    return () => cleanup?.();
  }, []);

  // Pagination args. Search overrides tag (Algolia-style — every
  // marketplace does this) so search results aren't artificially scoped
  // to a tag the user picked five minutes ago.
  const trimmedSearch = debouncedQuery.trim();
  const paginationArgs = useMemo(
    () => ({
      sort,
      tag:
        trimmedSearch.length === 0 && activeTag !== ALL_TAG
          ? activeTag
          : undefined,
      search: trimmedSearch.length > 0 ? trimmedSearch : undefined,
    }),
    [activeTag, sort, trimmedSearch],
  );

  const { results, status, loadMore } = usePaginatedQuery(
    api.data.pets.listPublicPage,
    paginationArgs,
    { initialNumItems: PAGE_SIZE },
  );

  const remotePets = useMemo<BuiltInPet[]>(() => {
    return (results as Array<Partial<BuiltInPet>>)
      .map(normalizePet)
      .filter((pet): pet is BuiltInPet => pet !== null);
  }, [results]);

  // Mirror the first page into cache + per-id cache so the overlay
  // (which uses the same `writeCachedPetById` shape) and the next cold
  // start can both render synchronously.
  useEffect(() => {
    if (remotePets.length === 0) return;
    const firstPage = remotePets.slice(0, PAGE_SIZE);
    writeCachedPetCatalogFirstPage(firstPage);
    cachedFirstPageRef.current = firstPage;
    for (const pet of firstPage) writeCachedPetById(pet);
  }, [remotePets]);

  const tagFacets = useTagFacets();
  const tagOptions = useMemo<string[]>(() => {
    if (!tagFacets || tagFacets.length === 0) {
      // Fallback while facets load: derive a tag set from the cached
      // first page so the pill row never flashes empty.
      const set = new Set<string>();
      for (const pet of cachedFirstPageRef.current) {
        for (const tag of pet.tags) set.add(tag);
      }
      return Array.from(set).sort();
    }
    return tagFacets.map((facet) => facet.tag);
  }, [tagFacets]);

  // Render order: bundled pets first (deduped against remote so a pet
  // that's both bundled AND seeded into Convex appears once), then the
  // server-paginated results. While the first page is still loading we
  // surface the cached first page in place of remote results so the UI
  // is never blank.
  const userPetsForGrid = useMemo<BuiltInPet[]>(() => {
    return publicUserPets
      .filter((pet) => !ownedUserPetIds.has(pet.petId))
      .map(userPetToBuiltIn);
  }, [ownedUserPetIds, publicUserPets]);

  const visiblePets = useMemo<BuiltInPet[]>(() => {
    const bundled = filterBundledPets(activeTag, debouncedQuery, sort);
    const seen = new Set(bundled.map((pet) => pet.id));
    const networkPets =
      remotePets.length > 0
        ? remotePets
        : status === "LoadingFirstPage"
          ? cachedFirstPageRef.current.filter((pet) => {
              if (activeTag !== ALL_TAG && !pet.tags.includes(activeTag)) {
                return false;
              }
              return true;
            })
          : [];
    const remoteFiltered = networkPets.filter((pet) => !seen.has(pet.id));
    for (const pet of remoteFiltered) seen.add(pet.id);
    const userFiltered = userPetsForGrid.filter((pet) => !seen.has(pet.id));
    return [...bundled, ...remoteFiltered, ...userFiltered];
  }, [activeTag, debouncedQuery, remotePets, sort, status, userPetsForGrid]);

  const isLoadingFirstPage = status === "LoadingFirstPage";
  const canLoadMore = status === "CanLoadMore";
  const isLoadingMore = status === "LoadingMore";
  const showPagingFooter = canLoadMore || isLoadingMore;

  // Auto-load the next page as the sentinel approaches the viewport.
  // 600px rootMargin so the next batch lands before the user notices.
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

  const { isInstalled, install, uninstall } = useInstalledPets();

  const userPetIds = useMemo(() => {
    const set = new Set<string>();
    for (const pet of publicUserPets) set.add(pet.petId);
    for (const pet of myUserPets ?? []) set.add(pet.petId);
    return set;
  }, [myUserPets, publicUserPets]);

  /** Bump the right install/download counter for the pet's source. */
  const recordOneInstall = useCallback(
    async (petId: string): Promise<void> => {
      if (incrementedRef.current.has(petId)) return;
      incrementedRef.current.add(petId);
      const isUserPet = userPetIds.has(petId);
      const promise = isUserPet
        ? recordUserPetInstall({ petId })
        : incrementDownloads({ id: petId });
      try {
        await promise;
      } catch (err) {
        incrementedRef.current.delete(petId);
        throw err;
      }
    },
    [incrementDownloads, recordUserPetInstall, userPetIds],
  );

  const handleGet = useCallback(
    async (id: string) => {
      if (!hasConnectedAccount) {
        showToast({
          title: "Sign in to get pets",
          variant: "error",
        });
        return;
      }
      try {
        await recordOneInstall(id);
        install(id);
        setSelectedPetId(id);
        if (!petOpen) {
          writePetOpenPreference(true);
          setPetOpenState(true);
          window.electronAPI?.pet?.setOpen?.(true);
        }
      } catch (err) {
        showToast({
          title: err instanceof Error ? err.message : "Couldn't get pet",
          variant: "error",
        });
      }
    },
    [
      hasConnectedAccount,
      install,
      petOpen,
      recordOneInstall,
      setSelectedPetId,
    ],
  );

  const handleSelect = useCallback(
    async (id: string) => {
      // Select implies installed. Bundled pets are always installed.
      if (!isBundledPetId(id) && !isInstalled(id)) {
        if (!hasConnectedAccount) {
          showToast({
            title: "Sign in to get pets",
            variant: "error",
          });
          return;
        }
        try {
          await recordOneInstall(id);
          install(id);
        } catch (err) {
          showToast({
            title: err instanceof Error ? err.message : "Couldn't get pet",
            variant: "error",
          });
          return;
        }
      }
      setSelectedPetId(id);
      if (!petOpen) {
        writePetOpenPreference(true);
        setPetOpenState(true);
        window.electronAPI?.pet?.setOpen?.(true);
      }
    },
    [
      hasConnectedAccount,
      install,
      isInstalled,
      petOpen,
      recordOneInstall,
      setSelectedPetId,
    ],
  );

  const handleRemove = useCallback(
    (id: string) => {
      if (isBundledPetId(id)) return;
      uninstall(id);
      if (selectedPetId === id) {
        setSelectedPetId(DEFAULT_PET_ID);
      }
    },
    [selectedPetId, setSelectedPetId, uninstall],
  );

  const handleToggle = useCallback(() => {
    const next = !petOpen;
    writePetOpenPreference(next);
    setPetOpenState(next);
    window.electronAPI?.pet?.setOpen?.(next);
  }, [petOpen]);

  const handleSetUserPetVisibility = useCallback(
    async (pet: UserPetRecord, next: UserPetVisibility) => {
      try {
        await setUserPetVisibility({ petId: pet.petId, visibility: next });
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
    [setUserPetVisibility],
  );

  const handleDeleteUserPet = useCallback(
    async (pet: UserPetRecord) => {
      try {
        await deleteUserPet({ petId: pet.petId });
        if (selectedPetId === pet.petId) {
          setSelectedPetId(DEFAULT_PET_ID);
        }
        showToast({ title: "Pet deleted", variant: "success" });
      } catch (err) {
        showToast({
          title: err instanceof Error ? err.message : "Couldn't delete pet",
          variant: "error",
        });
      }
    },
    [deleteUserPet, selectedPetId, setSelectedPetId],
  );

  return (
    <main className="pets-page">
      <header className="pets-page-header">
        <div className="pets-page-heading">
          <h1 className="pets-page-title">Pets</h1>
          <span className="pets-page-count">
            {visiblePets.length}
            {canLoadMore ? "+" : ""} loaded
          </span>
        </div>
        <p className="pets-page-subtitle">
          Pick a floating Stella companion to perch above your work. Pets react
          to what Stella is doing — running, waiting on you, or just hanging
          out — and surface their last status without making you switch
          windows. Right-click the pet anywhere on screen to swap or close it.
        </p>
      </header>

      <div className="pets-toolbar">
        <label className="pets-search">
          <Search size={14} className="pets-search-icon" aria-hidden="true" />
          <input
            type="search"
            placeholder="Search by name, description, or creator"
            className="pets-search-input"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div className="pets-sort">
          <span className="pets-sort-label">Sort</span>
          <Select<SortOption>
            className="pets-sort-select"
            value={sort}
            onValueChange={(value) => setSort(value)}
            aria-label="Sort"
            options={(Object.keys(SORT_LABELS) as SortOption[]).map(
              (option) => ({
                value: option,
                label: SORT_LABELS[option],
              }),
            )}
          />
        </div>
        <div className="pets-toolbar-actions">
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
                  title: "Sign in to see your pets",
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
                My pets
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
                  title: "Sign in to create your own pet",
                  variant: "error",
                });
                return;
              }
              setCreateOpen(true);
            }}
          >
            <StellaLogoIcon size={14} aria-hidden />
            Create pet
          </Button>
          <Button
            variant={petOpen ? "secondary" : "primary"}
            size="normal"
            className={
              petOpen
                ? "pill-btn pill-btn--lg"
                : "pill-btn pill-btn--primary pill-btn--lg"
            }
            style={
              petOpen
                ? undefined
                : {
                    borderColor:
                      "color-mix(in oklch, var(--primary-foreground) 30%, transparent)",
                  }
            }
            onClick={handleToggle}
          >
            {petOpen ? "Hide pet" : "Show pet"}
          </Button>
        </div>
      </div>

      {viewMode === "discover" && myUserPets && myUserPets.length > 0 ? (
        <section className="pets-your-section">
          <div className="pets-your-header">
            <span className="pets-your-title">Your pets</span>
            <span className="pets-your-count">{myUserPets.length}</span>
          </div>
          <div className="pets-grid">
            {myUserPets.map((pet) => {
              const builtIn = userPetToBuiltIn(pet);
              const isSelected = pet.petId === selectedPetId;
              const cardState: PetCardActionState = isSelected
                ? "selected"
                : "installed";
              return (
                <PetCard
                  key={pet.petId}
                  pet={builtIn}
                  state={cardState}
                  removable={false}
                  ownIdleStrip
                  badge={
                    pet.visibility === "private"
                      ? { label: "Private", tier: "private" }
                      : pet.visibility === "unlisted"
                      ? { label: "Unlisted", tier: "unlisted" }
                      : null
                  }
                  onOpen={() => setDetailsTarget(builtIn)}
                  onGet={() => handleGet(pet.petId)}
                  onSelect={() => handleSelect(pet.petId)}
                  onRemove={() => handleRemove(pet.petId)}
                  menu={
                    <div onClick={(event) => event.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="pets-card-menu-btn"
                          aria-label={`More actions for ${pet.displayName}`}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        sideOffset={6}
                        className="store-card-menu"
                      >
                        <DropdownMenuLabel>Visibility</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={pet.visibility}
                          onValueChange={(value) => {
                            if (
                              value === "public" ||
                              value === "unlisted" ||
                              value === "private"
                            ) {
                              void handleSetUserPetVisibility(pet, value);
                            }
                          }}
                        >
                          <DropdownMenuRadioItem value="public">
                            <div className="store-card-menu-item-text">
                              <span className="store-card-menu-item-title">
                                Public
                              </span>
                              <span className="store-card-menu-item-sub">
                                Listed on the Store
                              </span>
                            </div>
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="unlisted">
                            <div className="store-card-menu-item-text">
                              <span className="store-card-menu-item-title">
                                Unlisted
                              </span>
                              <span className="store-card-menu-item-sub">
                                Anyone with the link
                              </span>
                            </div>
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="private">
                            <div className="store-card-menu-item-text">
                              <span className="store-card-menu-item-title">
                                Private
                              </span>
                              <span className="store-card-menu-item-sub">
                                Only you
                              </span>
                            </div>
                          </DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setShareTarget(pet)}>
                          Share with friends
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          data-variant="destructive"
                          onSelect={() => {
                            const ok = window.confirm(
                              `Delete "${pet.displayName}"? This cannot be undone.`,
                            );
                            if (ok) void handleDeleteUserPet(pet);
                          }}
                        >
                          Delete pet
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    </div>
                  }
                />
              );
            })}
          </div>
        </section>
      ) : null}

      {viewMode === "discover" ? (
        <div className="pets-tags" role="tablist" aria-label="Filter by tag">
          <button
            type="button"
            role="tab"
            className="pets-tag-pill"
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
              className="pets-tag-pill"
              data-active={activeTag === tag ? "true" : "false"}
              aria-selected={activeTag === tag}
              onClick={() => setActiveTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}

      {viewMode === "discover" ? (
        visiblePets.length === 0 && !isLoadingFirstPage ? (
          <div className="pets-empty">
            No pets match that filter — try a different tag or clear the search.
          </div>
        ) : (
          <>
            <div className="pets-grid">
              {visiblePets.map((pet) => {
                const isSelected = pet.id === selectedPetId;
                const installed = isInstalled(pet.id);
                const cardState: PetCardActionState = isSelected
                  ? "selected"
                  : installed
                  ? "installed"
                  : "uninstalled";
                return (
                  <PetCard
                    key={pet.id}
                    pet={pet}
                    state={cardState}
                    removable={!isBundledPetId(pet.id)}
                    ownIdleStrip={userPetIds.has(pet.id)}
                    onOpen={() => setDetailsTarget(pet)}
                    onGet={() => setDetailsTarget(pet)}
                    onSelect={() => handleSelect(pet.id)}
                    onRemove={() => handleRemove(pet.id)}
                  />
                );
              })}
            </div>
            {showPagingFooter && (
              <div
                ref={sentinelRef}
                className="pets-grid-sentinel"
                data-loading={isLoadingMore ? "true" : "false"}
                aria-hidden="true"
              >
                {isLoadingMore ? "Loading more…" : ""}
              </div>
            )}
          </>
        )
      ) : (
        <section className="pets-your-section">
          <div className="pets-your-header">
            <span className="pets-your-title">My pets</span>
            {myUserPets && myUserPets.length > 0 ? (
              <span className="pets-your-count">{myUserPets.length}</span>
            ) : null}
          </div>
          {!myUserPets ? (
            <div className="pets-empty">Loading…</div>
          ) : myUserPets.length === 0 ? (
            <div className="pets-empty">
              You haven't created any pets yet.
            </div>
          ) : (
            <div className="pets-grid">
              {myUserPets.map((pet) => {
                const builtIn = userPetToBuiltIn(pet);
                const isSelected = pet.petId === selectedPetId;
                const cardState: PetCardActionState = isSelected
                  ? "selected"
                  : "installed";
                return (
                  <PetCard
                    key={pet.petId}
                    pet={builtIn}
                    state={cardState}
                    removable={false}
                    ownIdleStrip
                    badge={
                      pet.visibility === "private"
                        ? { label: "Private", tier: "private" }
                        : pet.visibility === "unlisted"
                        ? { label: "Unlisted", tier: "unlisted" }
                        : null
                    }
                    onOpen={() => setDetailsTarget(builtIn)}
                    onGet={() => handleGet(pet.petId)}
                    onSelect={() => handleSelect(pet.petId)}
                    onRemove={() => handleRemove(pet.petId)}
                    menu={
                      <div onClick={(event) => event.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="pets-card-menu-btn"
                              aria-label={`More actions for ${pet.displayName}`}
                            >
                              <MoreHorizontal size={14} />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            sideOffset={6}
                            className="store-card-menu"
                          >
                            <DropdownMenuLabel>Visibility</DropdownMenuLabel>
                            <DropdownMenuRadioGroup
                              value={pet.visibility}
                              onValueChange={(value) => {
                                if (
                                  value === "public" ||
                                  value === "unlisted" ||
                                  value === "private"
                                ) {
                                  void handleSetUserPetVisibility(pet, value);
                                }
                              }}
                            >
                              <DropdownMenuRadioItem value="public">
                                <div className="store-card-menu-item-text">
                                  <span className="store-card-menu-item-title">
                                    Public
                                  </span>
                                  <span className="store-card-menu-item-sub">
                                    Listed on the Store
                                  </span>
                                </div>
                              </DropdownMenuRadioItem>
                              <DropdownMenuRadioItem value="unlisted">
                                <div className="store-card-menu-item-text">
                                  <span className="store-card-menu-item-title">
                                    Unlisted
                                  </span>
                                  <span className="store-card-menu-item-sub">
                                    Anyone with the link
                                  </span>
                                </div>
                              </DropdownMenuRadioItem>
                              <DropdownMenuRadioItem value="private">
                                <div className="store-card-menu-item-text">
                                  <span className="store-card-menu-item-title">
                                    Private
                                  </span>
                                  <span className="store-card-menu-item-sub">
                                    Only you
                                  </span>
                                </div>
                              </DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setShareTarget(pet)}>
                              Share with friends
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              data-variant="destructive"
                              onSelect={() => {
                                const ok = window.confirm(
                                  `Delete "${pet.displayName}"? This cannot be undone.`,
                                );
                                if (ok) void handleDeleteUserPet(pet);
                              }}
                            >
                              Delete pet
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    }
                  />
                );
              })}
            </div>
          )}
        </section>
      )}

      <CreatePetDialog open={createOpen} onOpenChange={setCreateOpen} />
      {shareTarget ? (
        <SharePetDialog
          open
          onOpenChange={(next) => {
            if (!next) setShareTarget(null);
          }}
          pet={shareTarget}
        />
      ) : null}
      {detailsTarget ? (
        <PetDetailsDialog
          pet={detailsTarget}
          state={
            detailsTarget.id === selectedPetId
              ? "selected"
              : isInstalled(detailsTarget.id)
                ? "installed"
                : "uninstalled"
          }
          removable={!isBundledPetId(detailsTarget.id)}
          onOpenChange={(next) => {
            if (!next) setDetailsTarget(null);
          }}
          onGet={() => handleGet(detailsTarget.id)}
          onSelect={() => handleSelect(detailsTarget.id)}
          onRemove={() => handleRemove(detailsTarget.id)}
        />
      ) : null}
    </main>
  );
};

export default PetsApp;
