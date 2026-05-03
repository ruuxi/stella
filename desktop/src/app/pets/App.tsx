import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Download, Search } from "lucide-react";
import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/ui/button";
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

export const PetsApp = () => {
  const incrementDownloads = useMutation(api.data.pets.incrementDownloads);
  const [selectedPetId, setSelectedPetId] = useSelectedPetId(DEFAULT_PET_ID);
  const [activeTag, setActiveTag] = useState<string>(ALL_TAG);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<SortOption>("downloads");
  const [petOpen, setPetOpenState] = useState<boolean>(() =>
    readPetOpenPreference(),
  );
  const sentinelRef = useRef<HTMLDivElement | null>(null);
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
  const visiblePets = useMemo<BuiltInPet[]>(() => {
    const bundled = filterBundledPets(activeTag, debouncedQuery, sort);
    const seenBundled = new Set(bundled.map((pet) => pet.id));
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
    const remoteFiltered = networkPets.filter(
      (pet) => !seenBundled.has(pet.id),
    );
    return [...bundled, ...remoteFiltered];
  }, [activeTag, debouncedQuery, remotePets, sort, status]);

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

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedPetId(id);
      if (!petOpen) {
        writePetOpenPreference(true);
        setPetOpenState(true);
        window.electronAPI?.pet?.setOpen?.(true);
      }
      if (!incrementedRef.current.has(id)) {
        incrementedRef.current.add(id);
        void incrementDownloads({ id }).catch(() => {
          // Best-effort counter; if the bump fails (offline, rate limit,
          // etc.) just allow a future session to retry.
          incrementedRef.current.delete(id);
        });
      }
    },
    [incrementDownloads, petOpen, setSelectedPetId],
  );

  const handleToggle = useCallback(() => {
    const next = !petOpen;
    writePetOpenPreference(next);
    setPetOpenState(next);
    window.electronAPI?.pet?.setOpen?.(next);
  }, [petOpen]);

  return (
    <main className="pets-page" data-stella-section="pets">
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
            data-stella-action="search-pets"
            data-stella-label="Search pets"
          />
        </label>
        <label className="pets-sort">
          <span className="pets-sort-label">Sort</span>
          <select
            className="pets-sort-select"
            value={sort}
            onChange={(event) => setSort(event.currentTarget.value as SortOption)}
            data-stella-action="sort-pets"
            data-stella-label="Sort pets"
          >
            {(Object.keys(SORT_LABELS) as SortOption[]).map((option) => (
              <option key={option} value={option}>
                {SORT_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <div className="pets-toolbar-actions">
          <Button
            variant="secondary"
            size="small"
            disabled
            title="Create-your-own pet is coming soon"
            data-stella-action="create-pet"
            data-stella-label="Create pet"
            data-stella-state="coming-soon"
          >
            Create pet
          </Button>
          <Button
            variant={petOpen ? "secondary" : "primary"}
            size="small"
            onClick={handleToggle}
            data-stella-action="toggle-pet"
            data-stella-label={petOpen ? "Hide pet" : "Show pet"}
            data-stella-state={petOpen ? "active" : "inactive"}
          >
            {petOpen ? "Hide pet" : "Show pet"}
          </Button>
        </div>
      </div>

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

      {visiblePets.length === 0 && !isLoadingFirstPage ? (
        <div className="pets-empty">
          No pets match that filter — try a different tag or clear the search.
        </div>
      ) : (
        <>
          <div className="pets-grid">
            {visiblePets.map((pet) => {
              const isSelected = pet.id === selectedPetId;
              return (
                <div key={pet.id} className="pets-card-wrapper">
                  <button
                    type="button"
                    className="pets-card"
                    data-selected={isSelected ? "true" : "false"}
                    onClick={() => handleSelect(pet.id)}
                    data-stella-action="select-pet"
                    data-stella-label={pet.displayName}
                    data-stella-state={isSelected ? "selected" : "available"}
                  >
                    <div className="pets-card-sprite">
                      <PetSprite
                        spritesheetUrl={pet.spritesheetUrl}
                        state="idle"
                        size={84}
                      />
                    </div>
                    <div className="pets-card-name">{pet.displayName}</div>
                    <div className="pets-card-description">
                      {pet.description}
                    </div>
                    <div className="pets-card-meta">
                      <span className="pets-card-creator">
                        by {pet.creator}
                      </span>
                      <span
                        className="pets-card-downloads"
                        title={`${pet.downloads.toLocaleString()} selections`}
                      >
                        <Download size={11} aria-hidden="true" />
                        {formatDownloads(pet.downloads)}
                      </span>
                    </div>
                  </button>
                  {isSelected && (
                    <span className="pets-card-selected-badge">Selected</span>
                  )}
                </div>
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
      )}
    </main>
  );
};

export default PetsApp;
