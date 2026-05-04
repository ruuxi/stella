import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useConvex, useQuery, useMutation, usePaginatedQuery } from "convex/react"
import { api } from "@/convex/api"
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreInstallRecord,
  StellaConnectorSummary,
} from "@/shared/types/electron"

// Phase 1 alias: StoreView still uses the old type name in a lot of
// signatures. Map it to the new Phase 1 record so we don't have to
// touch every call site this turn — the new shape exposes
// `releaseNumber` + `packageId` which is what the UI actually reads.
type InstalledStoreModRecord = StoreInstallRecord
import { showToast } from "@/ui/toast"
import { Markdown } from "@/app/chat/Markdown"
import {
  ChevronLeft,
  Clock,
  Layers,
  MoreHorizontal,
  Package,
  Plug,
  Search,
  Share2,
} from "lucide-react"
import { useSelfModTaintMonitor } from "@/systems/boot/use-self-mod-taint-monitor"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogCloseButton } from "@/ui/dialog"
import { Button } from "@/ui/button"
import { TextField } from "@/ui/text-field"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/ui/dropdown-menu"
import { openStoreDisplayTab } from "@/shell/display/default-tabs"
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state"
import "@/global/integrations/credential-modal.css"
import { FashionTab } from "./fashion/FashionTab"
import { PetsApp } from "@/app/pets/App"
import { EmojiStorePage } from "./emojis/EmojiStorePage"
import { ShareAddonDialog } from "./ShareAddonDialog"
import {
  DEFAULT_STORE_TAB,
  type StoreTab,
} from "./store-tabs"
import "./store.css"

// Visibility tier handed down to owner controls. Treats undefined as
// "public" so legacy rows render with the right radio selected.
type AddonVisibility = "public" | "unlisted" | "private"
const effectiveVisibility = (
  v: AddonVisibility | undefined,
): AddonVisibility => v ?? "public"

type OwnerControls = {
  visibility: AddonVisibility
  onSetVisibility: (next: AddonVisibility) => Promise<void> | void
  onDelete: () => Promise<void> | void
}

type PendingAddonInstall = {
  pkg: StorePackageRecord
  release: StorePackageReleaseRecord
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const GRADIENTS = [
  "linear-gradient(135deg, oklch(0.72 0.15 25), oklch(0.58 0.20 50))",
  "linear-gradient(135deg, oklch(0.68 0.13 205), oklch(0.52 0.17 230))",
  "linear-gradient(135deg, oklch(0.70 0.15 145), oklch(0.55 0.18 170))",
  "linear-gradient(135deg, oklch(0.68 0.16 280), oklch(0.52 0.20 305))",
  "linear-gradient(135deg, oklch(0.73 0.12 80), oklch(0.60 0.16 55))",
  "linear-gradient(135deg, oklch(0.66 0.17 340), oklch(0.52 0.22 10))",
  "linear-gradient(135deg, oklch(0.66 0.11 215), oklch(0.50 0.15 240))",
  "linear-gradient(135deg, oklch(0.70 0.14 165), oklch(0.54 0.17 190))",
]

function hashString(value: string): number {
  let h = 0
  for (const ch of value) h = ((h << 5) - h + ch.charCodeAt(0)) | 0
  return Math.abs(h)
}

function getGradient(name: string): string {
  return GRADIENTS[hashString(name) % GRADIENTS.length]!
}

function getInitial(name: string): string {
  return (name.trim()[0] ?? "S").toUpperCase()
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 60) return "Just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(ms)
}

function getFileCount(release: StorePackageReleaseRecord): number {
  const m = release.manifest as Record<string, unknown> | undefined
  if (!m) return 0
  const files = (m.files ?? m.changedFiles) as string[] | undefined
  return Array.isArray(files) ? files.length : 0
}

function getReleaseNotes(
  release: StorePackageReleaseRecord,
): string | undefined {
  const m = release.manifest as Record<string, unknown> | undefined
  const notes =
    (release as Record<string, unknown>).releaseNotes ??
    m?.releaseNotes ??
    m?.summary
  return typeof notes === "string" && notes.trim() ? notes.trim() : undefined
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useStoreApi() {
  return window.electronAPI?.store ?? null
}

// Stale-while-revalidate cache shared across mounts. The Store route is
// lazy-mounted, so without this every navigation back to /store would re-show
// the skeleton and re-issue the same Convex roundtrip. We render the cached
// snapshot immediately and only refetch in the background when the entry has
// gone stale (TTL) — mutations still call reload() to bypass the cache.
const STORE_CACHE_TTL_MS = 30_000

type StoreCacheEntry<T> = { data: T; fetchedAt: number }

const storeCache = new Map<string, StoreCacheEntry<unknown>>()

function readStoreCache<T>(key: string): StoreCacheEntry<T> | null {
  const entry = storeCache.get(key)
  return (entry as StoreCacheEntry<T> | undefined) ?? null
}

function writeStoreCache<T>(key: string, data: T): void {
  storeCache.set(key, { data, fetchedAt: Date.now() })
}

function isStoreCacheFresh(entry: StoreCacheEntry<unknown> | null): boolean {
  return entry !== null && Date.now() - entry.fetchedAt < STORE_CACHE_TTL_MS
}

// Calls into the Store catalog hit Convex through the runtime. When the user
// hasn't connected an account yet the runtime rejects with an "auth required"
// or "not connected" message; we silence those into an empty state instead of
// presenting them as scary errors. Genuine failures still surface.
function isAuthOrConnectivityErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("authentication required") ||
    normalized.includes("unauthenticated") ||
    normalized.includes("not connected to convex") ||
    normalized.includes("sign in")
  )
}

function isAuthOrConnectivityError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return isAuthOrConnectivityErrorMessage(err.message)
}

function isStoreUpdateAvailable(
  pkg: StorePackageRecord,
  installed?: InstalledStoreModRecord,
) {
  return installed ? installed.releaseNumber < pkg.latestReleaseNumber : false
}

type PackagesCachePayload = {
  packages: StorePackageRecord[]
  installed: InstalledStoreModRecord[]
}

function useStorePackages(hasSession: boolean) {
  const api = useStoreApi()
  const cached = readStoreCache<PackagesCachePayload>("packages")
  const [packages, setPackages] = useState<StorePackageRecord[]>(
    cached?.data.packages ?? [],
  )
  const [installed, setInstalled] = useState<InstalledStoreModRecord[]>(
    cached?.data.installed ?? [],
  )
  const [loading, setLoading] = useState(cached === null)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!api || !hasSession) {
      setPackages([])
      setInstalled([])
      setError(null)
      setLoading(false)
      return
    }
    try {
      const [pkgs, mods] = await Promise.all([
        api.listPackages(),
        api.listInstalledMods(),
      ])
      writeStoreCache<PackagesCachePayload>("packages", {
        packages: pkgs,
        installed: mods,
      })
      if (!mountedRef.current) return
      setPackages(pkgs)
      setInstalled(mods)
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      if (isAuthOrConnectivityError(err)) {
        setPackages([])
        setInstalled([])
        setError(null)
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong")
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [api, hasSession])

  useEffect(() => {
    if (!hasSession) {
      void load()
      return
    }
    if (isStoreCacheFresh(readStoreCache<PackagesCachePayload>("packages"))) return
    void load()
  }, [hasSession, load])

  const installedMap = useMemo(() => {
    const map = new Map<string, InstalledStoreModRecord>()
    for (const mod of installed) {
      map.set(mod.packageId, mod)
    }
    return map
  }, [installed])

  return { packages, installed, installedMap, loading, error, reload: load }
}

/**
 * Public package listing used by the Discover surface. Walks every
 * page of `listPublicPackages` (Discover does category + search
 * filtering client-side, so we need the full catalog, not just the
 * first 40 rows). Capped at `PUBLIC_PACKAGE_PREFETCH_CAP` so a runaway
 * catalog can't pin the renderer.
 */
const PUBLIC_PACKAGE_PAGE_SIZE = 40
const PUBLIC_PACKAGE_PREFETCH_CAP = 800

function usePublicPackages() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.data.store_packages.listPublicPackages,
    {},
    { initialNumItems: PUBLIC_PACKAGE_PAGE_SIZE },
  ) as {
    results: StorePackageRecord[]
    status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"
    loadMore: (numItems: number) => void
  }

  // Auto-walk the rest of the catalog so Discover's client-side
  // category + search filters operate on the full set. Bounded to
  // avoid unbounded fetches.
  useEffect(() => {
    if (status !== "CanLoadMore") return
    if (results.length >= PUBLIC_PACKAGE_PREFETCH_CAP) return
    loadMore(PUBLIC_PACKAGE_PAGE_SIZE)
  }, [status, results.length, loadMore])

  return {
    packages: results,
    loading: status === "LoadingFirstPage",
  }
}

function useStoreConnectors() {
  const api = useStoreApi()
  const cached = readStoreCache<StellaConnectorSummary[]>("connectors")
  const [connectors, setConnectors] = useState<StellaConnectorSummary[]>(
    cached?.data ?? [],
  )
  const [loading, setLoading] = useState(cached === null)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    if (!api?.listConnectors) {
      setLoading(false)
      return
    }
    try {
      const result = await api.listConnectors()
      writeStoreCache<StellaConnectorSummary[]>("connectors", result)
      if (!mountedRef.current) return
      setConnectors(result)
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (isStoreCacheFresh(readStoreCache<StellaConnectorSummary[]>("connectors"))) return
    void load()
  }, [load])

  return { connectors, loading, error, reload: load }
}

function usePackageDetail(packageId: string | null) {
  // Public path so any creator's add-on opens, not just owned ones.
  const pkgResult = useQuery(
    api.data.store_packages.getPublicPackage,
    packageId ? { packageId } : "skip",
  ) as StorePackageRecord | null | undefined
  const releasesResult = useQuery(
    api.data.store_packages.listPublicReleases,
    packageId ? { packageId } : "skip",
  ) as StorePackageReleaseRecord[] | undefined

  const loading =
    Boolean(packageId) && (pkgResult === undefined || releasesResult === undefined)
  return {
    pkg: pkgResult ?? null,
    releases: releasesResult ?? [],
    loading,
    error: null as string | null,
  }
}

// ---------------------------------------------------------------------------
// Artwork: real backend-generated icon with gradient/monogram fallback
// ---------------------------------------------------------------------------

function PackageArtwork({
  iconUrl,
  name,
  className,
  letterClassName,
}: {
  iconUrl?: string
  name: string
  className?: string
  letterClassName?: string
}) {
  // Track failures locally so a 404 / CORS issue degrades to the deterministic
  // gradient on this render (rather than showing a broken image icon).
  const [failed, setFailed] = useState(false)
  const showImage = Boolean(iconUrl) && !failed

  return (
    <div
      className={`store-artwork ${className ?? ""}`}
      style={{ background: getGradient(name) }}
    >
      {showImage ? (
        <img
          src={iconUrl}
          alt=""
          className="store-artwork-img"
          onError={() => setFailed(true)}
          draggable={false}
          loading="lazy"
        />
      ) : (
        <span className={letterClassName}>{getInitial(name)}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Author display
// ---------------------------------------------------------------------------

function AuthorChip({
  name,
  handle,
  variant = "card",
}: {
  name?: string
  /**
   * Public creator handle. When present, the chip becomes a link to
   * `/c/:handle`. Falls back to a plain text label when omitted (e.g.
   * pre-handle-claim releases).
   */
  handle?: string
  variant?: "card" | "featured" | "detail"
}) {
  // `useNavigate` must run on every render to keep the hook order
  // stable. The previous `if (!name && !handle) return null` early
  // return before the hook would change the call order on any row
  // whose author metadata arrived asynchronously, which React flags
  // as a rules-of-hooks violation.
  const navigate = useNavigate()
  if (!name && !handle) return null
  const displayed = name?.trim() || handle!
  const initial = getInitial(displayed)
  const className =
    variant === "featured"
      ? "store-featured-author"
      : variant === "detail"
        ? "store-detail-author"
        : "store-card-author"
  const avatarClassName =
    variant === "featured"
      ? "store-featured-author-avatar"
      : variant === "detail"
        ? "store-detail-author-avatar"
        : "store-card-author-avatar"
  const Inner = (
    <>
      <span className={avatarClassName}>{initial}</span>
      <span>by {displayed}</span>
    </>
  )
  if (handle) {
    return (
      <button
        type="button"
        className={`${className} ${className}--link`}
        onClick={(event) => {
          event.stopPropagation()
          void navigate({ to: "/c/$handle", params: { handle } })
        }}
      >
        {Inner}
      </button>
    )
  }
  return <div className={className}>{Inner}</div>
}

// ---------------------------------------------------------------------------
// Skeleton + status + empty state
// ---------------------------------------------------------------------------

function SkeletonGrid() {
  return (
    <div className="store-grid">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="store-skeleton-card">
          <div className="store-skeleton-image" />
          <div className="store-skeleton-body">
            <div className="store-skeleton-line" />
            <div className="store-skeleton-line store-skeleton-line--short" />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="store-empty">
      <div className="store-empty-icon">{icon}</div>
      <div className="store-empty-title">{title}</div>
      <div className="store-empty-desc">{description}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function StoreCard({
  pkg,
  actionLabel,
  actionVariant,
  actionDisabled,
  onAction,
  onClick,
  onShare,
  ownerControls,
}: {
  pkg: StorePackageRecord
  actionLabel: string
  actionVariant: string
  actionDisabled?: boolean
  onAction?: () => void
  onClick?: () => void
  /** Optional Share affordance. When provided a Share icon button is
   *  rendered inline beside the primary action button. */
  onShare?: () => void
  /** Owner-only kebab menu surfacing visibility + delete. Undefined for
   *  cards the current user does not own. */
  ownerControls?: OwnerControls
}) {
  return (
    <div
      className="store-card"
      data-clickable={onClick ? "true" : undefined}
      onClick={onClick}
    >
      <PackageArtwork
        iconUrl={pkg.iconUrl}
        name={pkg.displayName}
        className="store-card-image"
        letterClassName="store-card-image-letter"
      />
      <div className="store-card-body">
        <div className="store-card-top">
          <span className="store-card-name">
            {pkg.displayName}
            {ownerControls
            && ownerControls.visibility !== "public" ? (
              <span
                className="store-card-visibility-badge"
                data-tier={ownerControls.visibility}
              >
                {ownerControls.visibility === "private" ? "Private" : "Unlisted"}
              </span>
            ) : null}
          </span>
          <div className="store-card-actions">
            {onShare ? (
              <button
                type="button"
                className="store-icon-btn"
                aria-label="Share add-on"
                onClick={(e) => {
                  e.stopPropagation()
                  onShare()
                }}
              >
                <Share2 size={14} />
              </button>
            ) : null}
            {ownerControls ? (
              <CardOwnerMenu controls={ownerControls} packageName={pkg.displayName} />
            ) : null}
            <button
              className="store-action-btn"
              data-variant={actionVariant}
              disabled={actionDisabled}
              onClick={(e) => {
                e.stopPropagation()
                onAction?.()
              }}
            >
              {actionLabel}
            </button>
          </div>
        </div>
        <div className="store-card-desc">{pkg.description}</div>
        <div className="store-card-footer">
          <AuthorChip name={pkg.authorDisplayName} handle={pkg.authorHandle} />
          <span className="store-card-installs">{formatInstallCount(pkg.installCount)}</span>
        </div>
      </div>
    </div>
  )
}

function formatInstallCount(count: number | undefined): string {
  const n = count ?? 0
  if (n <= 0) return "New"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M installs`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K installs`
  return `${n} install${n === 1 ? "" : "s"}`
}

function CardOwnerMenu({
  controls,
  packageName,
}: {
  controls: OwnerControls
  packageName: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        asChild
        // Stop propagation so opening the menu doesn't also trigger the
        // card's `onClick` (which would navigate to the detail view).
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="store-icon-btn"
          aria-label={`More actions for ${packageName}`}
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="store-card-menu"
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenuLabel className="store-card-menu-label">Visibility</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={controls.visibility}
          onValueChange={(value) => {
            // Radix gives us `string`; we narrow to the visibility tier.
            if (value === "public" || value === "unlisted" || value === "private") {
              void controls.onSetVisibility(value)
            }
          }}
        >
          <DropdownMenuRadioItem value="public" className="store-card-menu-item">
            <div className="store-card-menu-item-text">
              <span className="store-card-menu-item-title">Public</span>
              <span className="store-card-menu-item-sub">Listed on the Store</span>
            </div>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="unlisted" className="store-card-menu-item">
            <div className="store-card-menu-item-text">
              <span className="store-card-menu-item-title">Unlisted</span>
              <span className="store-card-menu-item-sub">Anyone with the link</span>
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
          className="store-card-menu-item store-card-menu-item--danger"
          onSelect={() => {
            // Keep the destructive action explicitly confirmed — Radix
            // closes the menu after `onSelect`, so the confirm fires
            // cleanly out-of-tree.
            const ok = window.confirm(
              `Delete "${packageName}"? This cannot be undone. People who already installed it will keep their copy but won't get updates.`,
            )
            if (ok) void controls.onDelete()
          }}
        >
          Delete add-on
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FeaturedCard({
  pkg,
  isAdded,
  updateAvailable,
  isWorking,
  onAction,
  onClick,
}: {
  pkg: StorePackageRecord
  isAdded: boolean
  updateAvailable: boolean
  isWorking: boolean
  onAction: () => void
  onClick: () => void
}) {
  const label = isWorking
    ? updateAvailable
      ? "Updating..."
      : "Adding..."
    : updateAvailable
      ? "Update"
      : isAdded
        ? "Added"
        : "Get"
  return (
    <div className="store-featured" onClick={onClick}>
      <div
        className="store-featured-bg"
        style={{ background: getGradient(pkg.displayName) }}
      />
      <div className="store-featured-overlay" />
      <div className="store-featured-content">
        <PackageArtwork
          iconUrl={pkg.iconUrl}
          name={pkg.displayName}
          className="store-featured-icon"
          letterClassName="store-featured-icon-letter"
        />
        <div className="store-featured-text">
          <div className="store-featured-label">Featured</div>
          <div className="store-featured-name">{pkg.displayName}</div>
          <div className="store-featured-desc">{pkg.description}</div>
          <AuthorChip name={pkg.authorDisplayName} handle={pkg.authorHandle} variant="featured" />
        </div>
        <button
          className="store-action-btn store-action-btn--lg"
          data-variant={
            isWorking ? "working" : updateAvailable ? "get" : isAdded ? "added" : "get"
          }
          disabled={isWorking}
          onClick={(e) => {
            e.stopPropagation()
            onAction()
          }}
        >
          {label}
        </button>
      </div>
    </div>
  )
}

function AddedRow({
  installed,
  packages,
  onSelect,
}: {
  installed: InstalledStoreModRecord[]
  packages: StorePackageRecord[]
  onSelect: (packageId: string) => void
}) {
  const pkgMap = useMemo(() => {
    const map = new Map<string, StorePackageRecord>()
    for (const pkg of packages) map.set(pkg.packageId, pkg)
    return map
  }, [packages])

  const activeInstalls = installed
  if (activeInstalls.length === 0) return null

  return (
    <div className="store-section">
      <div className="store-section-header">
        <span className="store-section-title">Added to Stella</span>
        <span className="store-section-count">{activeInstalls.length}</span>
      </div>
      <div className="store-added-row">
        {activeInstalls.map((mod) => {
          const pkg = pkgMap.get(mod.packageId)
          const name = pkg?.displayName ?? "Add-on"
          const updateAvailable = pkg ? isStoreUpdateAvailable(pkg, mod) : false
          return (
            <div
              key={mod.packageId}
              className="store-added-chip"
              onClick={() => onSelect(mod.packageId)}
            >
              <PackageArtwork
                iconUrl={pkg?.iconUrl}
                name={name}
                className="store-added-chip-icon"
                letterClassName="store-added-chip-letter"
              />
              <span className="store-added-chip-name">{name}</span>
              {updateAvailable ? (
                <span className="store-added-chip-badge">Update</span>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Discover toolbar (search + category filter)
// ---------------------------------------------------------------------------

type DiscoverFilter =
  | "all"
  | "apps-games"
  | "productivity"
  | "customization"
  | "skills-agents"
  | "integrations"
  | "other"

const DISCOVER_FILTERS: Array<{ id: DiscoverFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "apps-games", label: "Apps & games" },
  { id: "productivity", label: "Productivity" },
  { id: "customization", label: "Customization" },
  { id: "skills-agents", label: "Skills & agents" },
  { id: "integrations", label: "Integrations" },
  { id: "other", label: "Other" },
]

function DiscoverToolbar({
  query,
  onQuery,
  filter,
  onFilter,
}: {
  query: string
  onQuery: (value: string) => void
  filter: DiscoverFilter
  onFilter: (next: DiscoverFilter) => void
}) {
  return (
    <div className="store-toolbar">
      <div className="store-search">
        <Search size={14} className="store-search-icon" />
        <input
          className="store-search-input"
          placeholder="Search the Store"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="store-filter">
        {DISCOVER_FILTERS.map((entry) => (
          <button
            key={entry.id}
            className="store-filter-pill"
            data-active={filter === entry.id || undefined}
            onClick={() => onFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function matchesPackageQuery(pkg: StorePackageRecord, q: string): boolean {
  if (!q) return true
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return (
    pkg.displayName.toLowerCase().includes(needle) ||
    pkg.description.toLowerCase().includes(needle) ||
    (pkg.authorDisplayName?.toLowerCase().includes(needle) ?? false)
  )
}

function pickFeaturedPackage(
  packages: StorePackageRecord[],
): StorePackageRecord | null {
  if (packages.length === 0) return null
  // Prefer an editorially flagged package — otherwise fall back to the most
  // recently updated. Sort defensively so order doesn't depend on whether the
  // backend already orders by updatedAt.
  const editorial = packages
    .filter((pkg) => pkg.featured === true)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return editorial[0] ?? packages.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
}

// ---------------------------------------------------------------------------
// Discover Tab
// ---------------------------------------------------------------------------

function DiscoverTab({
  packages,
  installed,
  installedMap,
  loading,
  error,
  onSelect,
  onInstall,
  onShare,
  ownerControlsFor,
}: {
  packages: StorePackageRecord[]
  installed: InstalledStoreModRecord[]
  installedMap: Map<string, InstalledStoreModRecord>
  loading: boolean
  error: string | null
  onSelect: (packageId: string) => void
  onInstall: (packageId: string) => Promise<void>
  onShare: (pkg: StorePackageRecord) => void
  ownerControlsFor: (pkg: StorePackageRecord) => OwnerControls | undefined
}) {
  const [working, setWorking] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<DiscoverFilter>("all")

  const handleInstall = useCallback(
    async (packageId: string) => {
      setWorking(packageId)
      try {
        await onInstall(packageId)
      } finally {
        setWorking(null)
      }
    },
    [onInstall],
  )

  if (loading) return <SkeletonGrid />

  if (error) {
    return (
      <div className="store-status" data-variant="error">
        {error}
      </div>
    )
  }

  if (packages.length === 0) {
    return (
      <EmptyState
        icon={<Package size={32} />}
        title="Nothing here yet"
        description="Add-ons for Stella will appear here as they become available."
      />
    )
  }

  const filtered = packages.filter((pkg) => {
    if (filter !== "all") {
      const category = pkg.category ?? "other"
      if (category !== filter) return false
    }
    return matchesPackageQuery(pkg, query)
  })

  const featured = pickFeaturedPackage(packages)
  // When the user is searching or filtering, drop the hero so the results
  // don't get visually overshadowed by a (now-irrelevant) feature pick.
  const showFeatured =
    featured !== null && filter === "all" && query.trim() === ""
  const rest = filtered.filter((pkg) => !showFeatured || pkg.packageId !== featured!.packageId)

  return (
    <>
      <DiscoverToolbar
        query={query}
        onQuery={setQuery}
        filter={filter}
        onFilter={setFilter}
      />

      {showFeatured && featured ? (
        <FeaturedCard
          pkg={featured}
          isAdded={installedMap.has(featured.packageId)}
          updateAvailable={isStoreUpdateAvailable(
            featured,
            installedMap.get(featured.packageId),
          )}
          isWorking={working === featured.packageId}
          onAction={() => {
            const updateAvailable = isStoreUpdateAvailable(
              featured,
              installedMap.get(featured.packageId),
            )
            if (installedMap.has(featured.packageId) && !updateAvailable) {
              onSelect(featured.packageId)
              return
            }
            void handleInstall(featured.packageId)
          }}
          onClick={() => onSelect(featured.packageId)}
        />
      ) : null}

      {filter === "all" && query.trim() === "" ? (
        <AddedRow installed={installed} packages={packages} onSelect={onSelect} />
      ) : null}

      {rest.length > 0 ? (
        <div className="store-section">
          <div className="store-section-header">
            <span className="store-section-title">
              {query.trim() === "" && filter === "all" ? "All Add-ons" : "Results"}
            </span>
            <span className="store-section-count">{rest.length}</span>
          </div>
          <div className="store-grid">
            {rest.map((pkg) => {
              const installedRecord = installedMap.get(pkg.packageId)
              const isAdded = Boolean(installedRecord)
              const updateAvailable = isStoreUpdateAvailable(pkg, installedRecord)
              const isWorking = working === pkg.packageId
              return (
                <StoreCard
                  key={pkg.packageId}
                  pkg={pkg}
                  actionLabel={
                    isWorking
                      ? updateAvailable
                        ? "Updating..."
                        : "Adding..."
                      : updateAvailable
                        ? "Update"
                        : isAdded
                          ? "Added"
                          : "Get"
                  }
                  actionVariant={
                    isWorking
                      ? "working"
                      : updateAvailable
                        ? "get"
                        : isAdded
                          ? "added"
                          : "get"
                  }
                  actionDisabled={(isAdded && !updateAvailable) || isWorking}
                  onAction={() => void handleInstall(pkg.packageId)}
                  onClick={() => onSelect(pkg.packageId)}
                  onShare={() => onShare(pkg)}
                  ownerControls={ownerControlsFor(pkg)}
                />
              )
            })}
          </div>
        </div>
      ) : (
        // Search/filter narrowed everything away — show a soft empty state
        // rather than a blank page beneath the toolbar.
        (query.trim() !== "" || filter !== "all") && (
          <EmptyState
            icon={<Search size={32} />}
            title="No matches"
            description="Try a different search or category."
          />
        )
      )}
    </>
  )
}


// ---------------------------------------------------------------------------
// Connect tab
// ---------------------------------------------------------------------------

function ConnectTab({
  connectors,
  loading,
  error,
  onInstall,
}: {
  connectors: StellaConnectorSummary[]
  loading: boolean
  error: string | null
  onInstall: (marketplaceKey: string) => Promise<void>
}) {
  const [working, setWorking] = useState<string | null>(null)

  const handleInstall = useCallback(
    async (marketplaceKey: string) => {
      setWorking(marketplaceKey)
      try {
        await onInstall(marketplaceKey)
      } finally {
        setWorking(null)
      }
    },
    [onInstall],
  )

  // Integrations renders as a section beneath the Discover feed, so when
  // there's nothing available we render nothing. The Discover feed above
  // already covers the "page is empty" case with its own empty state.
  if (loading) return null
  if (error) {
    return (
      <div className="store-status" data-variant="error">
        {error}
      </div>
    )
  }
  if (connectors.length === 0) return null

  return (
    <div className="store-section">
      <div className="store-section-header">
        <span className="store-section-title">Integrations</span>
        <span className="store-section-count">{connectors.length}</span>
      </div>
      <div className="store-connector-list">
        {connectors.map((connector) => {
          const ready = connector.executable === true
          const isWorking = working === connector.marketplaceKey
          const description =
            connector.description ??
            connector.integrationPath ??
            "Connect this service to Stella."
          const interactive = ready && !connector.installed && !isWorking
          const trigger = () => void handleInstall(connector.marketplaceKey)
          const actionLabel = isWorking
            ? "Adding..."
            : connector.installed
              ? "Connected"
              : ready
                ? "Add"
                : "Soon"
          const actionVariant = isWorking
            ? "working"
            : connector.installed
              ? "added"
              : ready
                ? "subtle"
                : "added"
          return (
            <div
              key={connector.id}
              className="store-connector-row"
              data-clickable={interactive ? "true" : undefined}
              onClick={interactive ? trigger : undefined}
            >
              <PackageArtwork
                name={connector.displayName}
                className="store-connector-icon"
                letterClassName="store-connector-icon-letter"
              />
              <div className="store-connector-text">
                <span className="store-connector-name">{connector.displayName}</span>
                <span className="store-connector-desc">{description}</span>
              </div>
              <button
                className="store-action-btn"
                data-variant={actionVariant}
                disabled={connector.installed || isWorking || !ready}
                onClick={(e) => {
                  e.stopPropagation()
                  trigger()
                }}
              >
                {actionLabel}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

type ConnectorCredentialPayload = {
  credential?: string
  config: Record<string, string>
}

function ConnectorCredentialDialog({
  connector,
  open,
  onSubmit,
  onCancel,
}: {
  connector: StellaConnectorSummary | null
  open: boolean
  onSubmit: (payload: ConnectorCredentialPayload) => Promise<void>
  onCancel: () => void
}) {
  const [credential, setCredential] = useState("")
  const [config, setConfig] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setCredential("")
    setConfig({})
    setError(null)
    setSubmitting(false)
  }, [open, connector?.marketplaceKey])

  if (!connector) return null

  const fields = connector.configFields ?? []
  const showCredentialField = connector.requiresCredential && fields.length === 0

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    const nextConfig: Record<string, string> = {}
    for (const field of fields) {
      const value = config[field.key]?.trim() ?? ""
      if (!value) {
        setError(`${field.label} is required.`)
        return
      }
      nextConfig[field.key] = value
    }
    const nextCredential = credential.trim()
    if (showCredentialField && !nextCredential) {
      setError("API key is required.")
      return
    }
    try {
      setSubmitting(true)
      await onSubmit({
        credential: showCredentialField ? nextCredential : undefined,
        config: nextConfig,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add this connector")
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}>
      <DialogContent fit className="credential-modal-content">
        <DialogCloseButton className="credential-modal-close" />
        <DialogBody className="credential-modal-body">
          <div className="credential-modal-hero">
            <div className="credential-modal-icon">
              <Plug size={20} />
            </div>
            <DialogTitle className="credential-modal-headline">
              Connect {connector.displayName}
            </DialogTitle>
            <DialogDescription className="credential-modal-sub">
              Add the details Stella needs to connect this service.
            </DialogDescription>
          </div>
          <form className="credential-modal-form" onSubmit={handleSubmit}>
            {showCredentialField ? (
              <TextField
                label="API key"
                type="password"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                placeholder="Paste your key"
                autoFocus
              />
            ) : null}
            {fields.map((field, index) => (
              <TextField
                key={field.key}
                label={field.label}
                type={field.secret ? "password" : "text"}
                value={config[field.key] ?? ""}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
                placeholder={field.placeholder ?? ""}
                autoFocus={index === 0 && !showCredentialField}
              />
            ))}
            {error ? <div className="credential-modal-error">{error}</div> : null}
            <div className="credential-modal-actions">
              <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                disabled={submitting}
                className="pill-btn pill-btn--lg credential-modal-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={submitting}
                className="pill-btn pill-btn--primary pill-btn--lg credential-modal-submit"
              >
                {submitting ? "Adding..." : "Add connector"}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function ConnectorConfirmDialog({
  connector,
  open,
  onConfirm,
  onCancel,
}: {
  connector: StellaConnectorSummary | null
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!connector) return null
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onCancel() : undefined)}>
      <DialogContent fit className="store-confirm-dialog" aria-describedby={undefined}>
        <DialogTitle className="store-confirm-title">
          Add {connector.displayName}?
        </DialogTitle>
        <DialogDescription className="store-confirm-description">
          Stella will add {connector.displayName} to your connected
          integrations. You can remove it any time.
        </DialogDescription>
        <div className="store-confirm-actions">
          <Button
            type="button"
            variant="ghost"
            size="large"
            className="pill-btn pill-btn--lg"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="large"
            className="pill-btn pill-btn--primary pill-btn--lg"
            onClick={onConfirm}
          >
            Add
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AddonInstallConfirmDialog({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: PendingAddonInstall | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog
      open={Boolean(pending)}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent fit className="store-blueprint-dialog">
        <DialogHeader>
          <DialogTitle>
            {pending ? `Add ${pending.pkg.displayName}?` : "Add"}
          </DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody>
          <div className="store-blueprint-dialog-viewer">
            {pending ? (
              <Markdown
                text={pending.release.blueprintMarkdown}
                cacheKey={`${pending.pkg.packageId}:${pending.release.releaseNumber}`}
              />
            ) : null}
          </div>
          <div className="store-install-confirm-copy">
            Stella will implement this blueprint locally and commit the
            resulting changes so you can remove it later.
          </div>
          <div className="store-blueprint-dialog-actions">
            <button
              type="button"
              className="pill-btn"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pill-btn pill-btn--primary"
              onClick={onConfirm}
            >
              Add to Stella
            </button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}


// ---------------------------------------------------------------------------
// Package Detail
// ---------------------------------------------------------------------------

function PackageDetailView({
  packageId,
  installedMap,
  onBack,
  onInstall,
  onRemove,
  onShare,
  ownerControlsFor,
}: {
  packageId: string
  installedMap: Map<string, InstalledStoreModRecord>
  onBack: () => void
  onInstall: (packageId: string) => Promise<void>
  onRemove: (packageId: string) => Promise<void>
  onShare: (pkg: StorePackageRecord) => void
  ownerControlsFor: (pkg: StorePackageRecord) => OwnerControls | undefined
}) {
  const { pkg, releases, loading, error } = usePackageDetail(packageId)
  const [working, setWorking] = useState(false)
  const installedRecord = installedMap.get(packageId)
  const isAdded = Boolean(installedRecord)

  const handleInstall = useCallback(async () => {
    setWorking(true)
    try {
      await onInstall(packageId)
    } finally {
      setWorking(false)
    }
  }, [onInstall, packageId])

  const handleRemove = useCallback(async () => {
    setWorking(true)
    try {
      await onRemove(packageId)
    } finally {
      setWorking(false)
    }
  }, [onRemove, packageId])

  if (loading) {
    return (
      <div className="store-detail">
        <button className="store-detail-back" onClick={onBack}>
          <ChevronLeft size={16} />
          Back
        </button>
        <SkeletonGrid />
      </div>
    )
  }

  if (error || !pkg) {
    return (
      <div className="store-detail">
        <button className="store-detail-back" onClick={onBack}>
          <ChevronLeft size={16} />
          Back
        </button>
        <div className="store-status" data-variant="error">
          {error ?? "This item is no longer available."}
        </div>
      </div>
    )
  }

  const latestRelease = releases[0]
  const latestNotes = latestRelease ? getReleaseNotes(latestRelease) : undefined
  const updateAvailable = isStoreUpdateAvailable(pkg, installedRecord)

  return (
    <div className="store-detail">
      <button className="store-detail-back" onClick={onBack}>
        <ChevronLeft size={16} />
        Back
      </button>

      <div className="store-detail-hero">
        <PackageArtwork
          iconUrl={pkg.iconUrl}
          name={pkg.displayName}
          className="store-detail-image"
          letterClassName="store-detail-image-letter"
        />
        <div className="store-detail-info">
          <div className="store-detail-name">{pkg.displayName}</div>
          <div className="store-detail-desc">{pkg.description}</div>
          <AuthorChip name={pkg.authorDisplayName} handle={pkg.authorHandle} variant="detail" />
          <div className="store-detail-meta store-detail-meta--spaced">
            <span className="store-detail-meta-item">
              <Layers size={13} />
              Version {pkg.latestReleaseNumber}
            </span>
            <span className="store-detail-meta-item">
              <Clock size={13} />
              Updated {formatTimeAgo(pkg.updatedAt)}
            </span>
          </div>
          <div className="store-detail-actions">
            {isAdded ? (
              <>
                {updateAvailable ? (
                  <button
                    className="store-action-btn store-action-btn--lg"
                    data-variant={working ? "working" : "get"}
                    onClick={() => void handleInstall()}
                    disabled={working}
                  >
                    {working ? "Updating..." : "Update"}
                  </button>
                ) : null}
                <button
                  className="store-action-btn store-action-btn--lg"
                  data-variant={working ? "working" : "remove"}
                  onClick={() => void handleRemove()}
                  disabled={working}
                >
                  {working ? "Removing..." : "Remove"}
                </button>
              </>
            ) : (
              <button
                className="store-action-btn store-action-btn--lg"
                data-variant={working ? "working" : "get"}
                onClick={() => void handleInstall()}
                disabled={working}
              >
                {working ? "Adding..." : "Add to Stella"}
              </button>
            )}
            <button
              type="button"
              className="store-icon-btn store-icon-btn--lg"
              aria-label="Share add-on"
              onClick={() => onShare(pkg)}
            >
              <Share2 size={16} />
            </button>
            {(() => {
              const controls = ownerControlsFor(pkg)
              return controls ? (
                <CardOwnerMenu controls={controls} packageName={pkg.displayName} />
              ) : null
            })()}
          </div>
        </div>
      </div>

      {latestNotes ? (
        <div className="store-whats-new">
          <div className="store-whats-new-eyebrow">What's New</div>
          <div className="store-whats-new-version">
            Version {latestRelease!.releaseNumber}
            {latestRelease ? ` · ${formatDate(latestRelease.createdAt)}` : ""}
          </div>
          <div className="store-whats-new-body">{latestNotes}</div>
        </div>
      ) : null}

      {releases.length > 1 ? (
        <>
          <hr className="store-detail-divider" />
          <div className="store-detail-section">
            <div className="store-detail-section-title">Version History</div>
            <div className="store-version-list">
              {releases.slice(1).map((release) => {
                const notes = getReleaseNotes(release)
                const fileCount = getFileCount(release)
                return (
                  <div key={release.releaseNumber} className="store-version-item">
                    <div className="store-version-label">
                      Version {release.releaseNumber}
                    </div>
                    {notes ? <div className="store-version-notes">{notes}</div> : null}
                    <div className="store-version-date">
                      {formatDate(release.createdAt)}
                      {fileCount > 0 ? ` \u00B7 ${fileCount} items customized` : ""}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Store View (main export)
// ---------------------------------------------------------------------------

interface StoreViewProps {
  /** Optional controlled active tab. Defaults to the first tab when absent. */
  activeTab?: StoreTab
  /** Notified whenever the user picks a tab (deep-linked via the route). */
  onActiveTabChange?: (tab: StoreTab) => void
  /**
   * Optional deep link to an add-on detail view. Sourced from `?package=`
   * on the `/store` route — used by creator pages and shareable links.
   * Changes track the URL so back/forward also work.
   */
  initialPackageId?: string
}

export function StoreView({
  activeTab: activeTabProp,
  onActiveTabChange: _onActiveTabChange,
  initialPackageId,
}: StoreViewProps = {}) {
  useSelfModTaintMonitor()
  const navigate = useNavigate()

  // `selectedTab` is only relevant when the route doesn't supply one
  // (e.g. tests mounting `<StoreView />` directly). The shell topbar's
  // `ShellTopBarStoreTabs` calls `_onActiveTabChange` for normal nav.
  const [selectedTab] = useState<StoreTab>(DEFAULT_STORE_TAB)
  const tab = activeTabProp ?? selectedTab

  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(
    initialPackageId ?? null,
  )

  // Keep the selected package in sync when the URL deep-link changes
  // (e.g. user clicks another card on a creator page without unmounting).
  useEffect(() => {
    setSelectedPackageId(initialPackageId ?? null)
  }, [initialPackageId])
  const [credentialConnector, setCredentialConnector] =
    useState<StellaConnectorSummary | null>(null)
  const [confirmConnector, setConfirmConnector] =
    useState<StellaConnectorSummary | null>(null)
  const [pendingAddonInstall, setPendingAddonInstall] =
    useState<PendingAddonInstall | null>(null)
  const { hasSession } = useAuthSessionState()

  const {
    installed,
    installedMap,
    loading: ownerPackagesLoading,
    error: packagesError,
    reload: reloadPackages,
  } = useStorePackages(hasSession)

  // Discover surfaces every public add-on (any creator), not just the
  // current user's own packages. Owner-only data above is still needed
  // for "Added" badges, install detection, and the side panel.
  const { packages: publicPackages, loading: publicPackagesLoading } =
    usePublicPackages()
  const packagesLoading = ownerPackagesLoading || publicPackagesLoading

  const {
    connectors,
    loading: connectorsLoading,
    error: connectorsError,
    reload: reloadConnectors,
  } = useStoreConnectors()

  // Owned-by-me set used to decide which cards render the owner kebab
  // (visibility + delete). `listMyPackages` is owner-scoped and always
  // returns every add-on the user owns regardless of its visibility, so
  // the owner can manage hidden / private rows that are absent from
  // Discover.
  const myPackages = useQuery(
    api.data.store_packages.listMyPackages,
    hasSession ? {} : "skip",
  ) as Array<{
    packageId: string
    visibility?: AddonVisibility
  }> | undefined
  const myPackageVisibility = useMemo(() => {
    const map = new Map<string, AddonVisibility>()
    for (const pkg of myPackages ?? []) {
      map.set(pkg.packageId, effectiveVisibility(pkg.visibility))
    }
    return map
  }, [myPackages])

  const setVisibilityMutation = useMutation(
    api.data.store_packages.setPackageVisibility,
  )
  const deletePackageMutation = useMutation(api.data.store_packages.deletePackage)

  const handleSetVisibility = useCallback(
    async (packageId: string, visibility: AddonVisibility) => {
      try {
        await setVisibilityMutation({ packageId, visibility })
        showToast({
          title:
            visibility === "public"
              ? "Listed on the Store"
              : visibility === "unlisted"
              ? "Unlisted (link only)"
              : "Hidden from everyone",
          variant: "success",
        })
        await reloadPackages()
      } catch (err) {
        showToast({
          title:
            err instanceof Error
              ? err.message
              : "Couldn't update visibility right now",
          variant: "error",
        })
      }
    },
    [setVisibilityMutation, reloadPackages],
  )

  const handleDeletePackage = useCallback(
    async (packageId: string) => {
      try {
        await deletePackageMutation({ packageId })
        showToast({ title: "Add-on deleted", variant: "success" })
        // If the user was viewing this add-on's detail view, fall back
        // to the list rather than leaving them on a "404 / no longer
        // available" placeholder.
        if (selectedPackageId === packageId) {
          setSelectedPackageId(null)
          if (initialPackageId === packageId) {
            void navigate({ to: "/store", search: { tab }, replace: true })
          }
        }
        await reloadPackages()
      } catch (err) {
        showToast({
          title:
            err instanceof Error ? err.message : "Couldn't delete this add-on",
          variant: "error",
        })
      }
    },
    [
      deletePackageMutation,
      reloadPackages,
      selectedPackageId,
      initialPackageId,
      tab,
      navigate,
    ],
  )

  const ownerControlsFor = useCallback(
    (pkg: StorePackageRecord): OwnerControls | undefined => {
      const visibility = myPackageVisibility.get(pkg.packageId)
      if (!visibility) return undefined
      return {
        visibility,
        onSetVisibility: (next) => handleSetVisibility(pkg.packageId, next),
        onDelete: () => handleDeletePackage(pkg.packageId),
      }
    },
    [myPackageVisibility, handleSetVisibility, handleDeletePackage],
  )

  // Share-flow state: a single dialog mounted at the top level of the
  // view; cards (and the detail view) toggle it by setting the package.
  const [sharePkg, setSharePkg] = useState<StorePackageRecord | null>(null)
  const handleShare = useCallback((pkg: StorePackageRecord) => {
    setSharePkg(pkg)
  }, [])

  const convex = useConvex()
  const handleInstall = useCallback(
    async (packageId: string, releaseNumber?: number) => {
      try {
        const pkg = await convex.query(api.data.store_packages.getPublicPackage, {
          packageId,
        })
        if (!pkg) {
          throw new Error("Add-on not found in store.")
        }
        const releases = (await convex.query(
          api.data.store_packages.listPublicReleases,
          { packageId },
        )) as StorePackageReleaseRecord[]
        const target =
          releaseNumber !== undefined
            ? releases.find((release) => release.releaseNumber === releaseNumber)
            : releases[0]
        if (!target) {
          throw new Error("No release available for this add-on.")
        }
        setPendingAddonInstall({ pkg, release: target })
      } catch (err) {
        showToast({
          title:
            err instanceof Error ? err.message : "Couldn't add this right now",
          variant: "error",
        })
      }
    },
    [convex],
  )

  const handleConfirmInstallAddon = useCallback(async () => {
    if (!pendingAddonInstall) return
    const electronStore = window.electronAPI?.store
    if (!electronStore) return
    const install = pendingAddonInstall
    const wasAlreadyInstalled = installedMap.has(install.pkg.packageId)
    setPendingAddonInstall(null)
    showToast({
      title: wasAlreadyInstalled ? "Updating add-on" : "Adding add-on",
      description: "Stella will let you know when it's finished.",
    })
    void (async () => {
      try {
        await electronStore.installFromBlueprint({
          packageId: install.pkg.packageId,
          releaseNumber: install.release.releaseNumber,
          displayName: install.pkg.displayName,
          blueprintMarkdown: install.release.blueprintMarkdown,
          ...(install.release.commits && install.release.commits.length > 0
            ? { commits: install.release.commits }
            : {}),
        })
        if (!wasAlreadyInstalled) {
          // Best-effort install counter bump. Failures here are silent —
          // missing the increment is much less bad than a half-installed
          // toast state.
          void convex
            .mutation(api.data.store_packages.recordPackageInstall, {
              packageId: install.pkg.packageId,
            })
            .catch(() => undefined)
        }
        showToast({ title: "Added to Stella", variant: "success" })
        await reloadPackages()
      } catch (err) {
        showToast({
          title:
            err instanceof Error ? err.message : "Couldn't add this right now",
          variant: "error",
        })
      }
    })()
  }, [pendingAddonInstall, installedMap, reloadPackages, convex])

  const handleConfirmInstallConnector = useCallback(() => {
    if (!confirmConnector) return
    const api = window.electronAPI?.store
    if (!api?.installConnector) return
    const connector = confirmConnector
    setConfirmConnector(null)
    showToast({
      title: "Adding connector",
      description: "Stella will let you know when it's finished.",
    })
    void (async () => {
      try {
        await api.installConnector(connector.marketplaceKey)
        showToast({ title: "Connector added to Stella", variant: "success" })
        await reloadConnectors()
      } catch (err) {
        showToast({
          title:
            err instanceof Error ? err.message : "Couldn't add this connector",
          variant: "error",
        })
      }
    })()
  }, [confirmConnector, reloadConnectors])

  const handleRemove = useCallback(
    async (packageId: string) => {
      const api = window.electronAPI?.store
      if (!api) return
      try {
        await api.uninstallPackage(packageId)
        showToast({ title: "Removed from Stella", variant: "success" })
        await reloadPackages()
      } catch (err) {
        showToast({
          title:
            err instanceof Error ? err.message : "Couldn't remove this right now",
          variant: "error",
        })
      }
    },
    [reloadPackages],
  )

  const handleInstallConnector = useCallback(
    async (marketplaceKey: string) => {
      const api = window.electronAPI?.store
      if (!api?.installConnector) return
      try {
        const connector = connectors.find(
          (entry) => entry.marketplaceKey === marketplaceKey,
        )
        if (!connector) return
        if (connector.requiresCredential || (connector.configFields?.length ?? 0) > 0) {
          setCredentialConnector(connector)
          return
        }
        setConfirmConnector(connector)
      } catch (err) {
        showToast({
          title:
            err instanceof Error ? err.message : "Couldn't add this connector",
          variant: "error",
        })
      }
    },
    [connectors],
  )

  const handleSubmitConnectorCredential = useCallback(
    async ({ credential, config }: ConnectorCredentialPayload) => {
      if (!credentialConnector) return
      const api = window.electronAPI?.store
      if (!api?.installConnector) return
      await api.installConnector(
        credentialConnector.marketplaceKey,
        credential,
        config,
      )
      setCredentialConnector(null)
      showToast({ title: "Connector added to Stella.", variant: "success" })
      await reloadConnectors()
    },
    [credentialConnector, reloadConnectors],
  )

  const handleOpenStoreUpload = useCallback(() => {
    if (!hasSession) {
      showToast({
        title: "Sign in to upload to the Store",
        variant: "error",
      })
      return
    }
    openStoreDisplayTab()
  }, [hasSession])

  // Single, top-level dialog instances. Earlier the publish dialog was
  // duplicated across the detail and main branches with the same state, which
  // worked but made it easy to drift the two copies. One mount only.
  const dialogs = (
    <>
      <ConnectorCredentialDialog
        connector={credentialConnector}
        open={Boolean(credentialConnector)}
        onSubmit={handleSubmitConnectorCredential}
        onCancel={() => setCredentialConnector(null)}
      />
      <ConnectorConfirmDialog
        connector={confirmConnector}
        open={Boolean(confirmConnector)}
        onConfirm={() => void handleConfirmInstallConnector()}
        onCancel={() => setConfirmConnector(null)}
      />
      <AddonInstallConfirmDialog
        pending={pendingAddonInstall}
        onConfirm={() => void handleConfirmInstallAddon()}
        onCancel={() => setPendingAddonInstall(null)}
      />
      {sharePkg ? (
        <ShareAddonDialog
          open
          onOpenChange={(open) => {
            if (!open) setSharePkg(null)
          }}
          pkg={sharePkg}
        />
      ) : null}
    </>
  )

  // Fashion + Pets + Emojis are full-bleed — they own the canvas and bring
  // their own scrolling/grid layout.
  const isFullBleedTab = tab === "fashion" || tab === "pets" || tab === "emojis"

  return (
    <div className="store-root" data-tab={selectedPackageId ? "discover" : tab}>
      {!isFullBleedTab || selectedPackageId ? (
        <button
          type="button"
          className="pill-btn pill-btn--primary pill-btn--lg store-upload-btn"
          onClick={handleOpenStoreUpload}
        >
          Upload to Store
        </button>
      ) : null}
      {isFullBleedTab && !selectedPackageId ? (
        tab === "pets" ? (
          <PetsApp />
        ) : tab === "emojis" ? (
          <EmojiStorePage />
        ) : (
          <FashionTab />
        )
      ) : (
        <div className="store-scroll">
          {selectedPackageId ? (
            <PackageDetailView
              packageId={selectedPackageId}
              installedMap={installedMap}
              onBack={() => {
                setSelectedPackageId(null)
                // If we got here via a `?package=…` deep link, also
                // clear it from the URL so refresh / back-forward
                // doesn't reopen the detail view the user just left.
                if (initialPackageId) {
                  void navigate({
                    to: "/store",
                    search: { tab },
                    replace: true,
                  })
                }
              }}
              onInstall={handleInstall}
              onRemove={handleRemove}
              onShare={handleShare}
              ownerControlsFor={ownerControlsFor}
            />
          ) : (
            <>
              <DiscoverTab
                packages={publicPackages}
                installed={installed}
                installedMap={installedMap}
                loading={packagesLoading}
                error={packagesError}
                onSelect={setSelectedPackageId}
                onInstall={handleInstall}
                onShare={handleShare}
                ownerControlsFor={ownerControlsFor}
              />
              <ConnectTab
                connectors={connectors}
                loading={connectorsLoading}
                error={connectorsError}
                onInstall={handleInstallConnector}
              />
            </>
          )}
        </div>
      )}

      {dialogs}
    </div>
  )
}
