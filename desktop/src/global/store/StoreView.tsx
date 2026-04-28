import { useState, useEffect, useCallback, useMemo } from "react"
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StorePublishDraft,
  InstalledStoreModRecord,
  LocalGitCommitRecord,
  StellaConnectorSummary,
} from "@/shared/types/electron"
import { showToast } from "@/ui/toast"
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left"
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right"
import Clock from "lucide-react/dist/esm/icons/clock"
import Layers from "lucide-react/dist/esm/icons/layers"
import Sparkles from "lucide-react/dist/esm/icons/sparkles"
import Package from "lucide-react/dist/esm/icons/package"
import Plug from "lucide-react/dist/esm/icons/plug"
import Search from "lucide-react/dist/esm/icons/search"
import { useSelfModTaintMonitor } from "@/systems/boot/use-self-mod-taint-monitor"
import { PageSidebar } from "@/context/page-sidebar"
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogBody, DialogCloseButton } from "@/ui/dialog"
import { Button } from "@/ui/button"
import { TextField } from "@/ui/text-field"
import "@/global/integrations/credential-modal.css"
import { FashionTab } from "./fashion/FashionTab"
import {
  DEFAULT_STORE_TAB,
  STORE_TAB_GROUP_LABELS,
  STORE_TAB_GROUP_ORDER,
  STORE_TABS,
  type StoreTab,
  type StoreTabGroup,
} from "./store-tabs"
import "./store.css"

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

function useStorePackages() {
  const api = useStoreApi()
  const [packages, setPackages] = useState<StorePackageRecord[]>([])
  const [installed, setInstalled] = useState<InstalledStoreModRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!api) {
      setLoading(false)
      return
    }
    try {
      const [pkgs, mods] = await Promise.all([
        api.listPackages(),
        api.listInstalledMods(),
      ])
      setPackages(pkgs)
      setInstalled(mods)
      setError(null)
    } catch (err) {
      if (isAuthOrConnectivityError(err)) {
        setPackages([])
        setInstalled([])
        setError(null)
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong")
      }
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const installedMap = useMemo(() => {
    const map = new Map<string, InstalledStoreModRecord>()
    for (const mod of installed) {
      if (mod.state === "installed") {
        map.set(mod.packageId, mod)
      }
    }
    return map
  }, [installed])

  return { packages, installed, installedMap, loading, error, reload: load }
}

function useLocalCommits(limit = 60) {
  const api = useStoreApi()
  const [commits, setCommits] = useState<LocalGitCommitRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!api?.listLocalCommits) {
      setLoading(false)
      return
    }
    try {
      const result = await api.listLocalCommits(limit)
      setCommits(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }, [api, limit])

  useEffect(() => {
    void load()
  }, [load])

  return { commits, loading, error, reload: load }
}

function useStoreConnectors() {
  const api = useStoreApi()
  const [connectors, setConnectors] = useState<StellaConnectorSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!api?.listConnectors) {
      setLoading(false)
      return
    }
    try {
      const result = await api.listConnectors()
      setConnectors(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  return { connectors, loading, error, reload: load }
}

function usePackageDetail(packageId: string | null) {
  const api = useStoreApi()
  const [pkg, setPkg] = useState<StorePackageRecord | null>(null)
  const [releases, setReleases] = useState<StorePackageReleaseRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api || !packageId) {
      setPkg(null)
      setReleases([])
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const [pkgResult, releasesResult] = await Promise.all([
          api.getPackage(packageId),
          api.listPackageReleases(packageId),
        ])
        if (!cancelled) {
          setPkg(pkgResult)
          setReleases(releasesResult)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          if (isAuthOrConnectivityError(err)) {
            setPkg(null)
            setReleases([])
            setError(null)
          } else {
            setError(err instanceof Error ? err.message : "Something went wrong")
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, packageId])

  return { pkg, releases, loading, error }
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
  variant = "card",
}: {
  name?: string
  variant?: "card" | "featured" | "detail"
}) {
  if (!name) return null
  const initial = getInitial(name)
  if (variant === "featured") {
    return (
      <div className="store-featured-author">
        <span className="store-featured-author-avatar">{initial}</span>
        <span>by {name}</span>
      </div>
    )
  }
  if (variant === "detail") {
    return (
      <div className="store-detail-author">
        <span className="store-detail-author-avatar">{initial}</span>
        <span>by {name}</span>
      </div>
    )
  }
  return (
    <div className="store-card-author">
      <span className="store-card-author-avatar">{initial}</span>
      <span>by {name}</span>
    </div>
  )
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
  meta,
  onAction,
  onClick,
}: {
  pkg: StorePackageRecord
  actionLabel: string
  actionVariant: string
  actionDisabled?: boolean
  meta?: string
  onAction?: () => void
  onClick?: () => void
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
          <span className="store-card-name">{pkg.displayName}</span>
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
        <div className="store-card-desc">{pkg.description}</div>
        <AuthorChip name={pkg.authorDisplayName} />
        {meta && <div className="store-card-meta">{meta}</div>}
      </div>
    </div>
  )
}

function FeaturedCard({
  pkg,
  isAdded,
  isWorking,
  onAction,
  onClick,
}: {
  pkg: StorePackageRecord
  isAdded: boolean
  isWorking: boolean
  onAction: () => void
  onClick: () => void
}) {
  return (
    <div className="store-featured" onClick={onClick}>
      <div
        className="store-featured-bg"
        style={{ background: getGradient(pkg.displayName) }}
      />
      {pkg.iconUrl ? (
        // Render the real icon as a soft, blurred backdrop so the hero stays
        // ownable by the package's actual artwork without losing the eyebrow
        // legibility the dark gradient provides.
        <img
          src={pkg.iconUrl}
          alt=""
          className="store-artwork-img store-featured-img"
          draggable={false}
        />
      ) : null}
      <div className="store-featured-overlay" />
      <div className="store-featured-content">
        <div className="store-featured-text">
          <div className="store-featured-label">Featured</div>
          <div className="store-featured-name">{pkg.displayName}</div>
          <div className="store-featured-desc">{pkg.description}</div>
          <AuthorChip name={pkg.authorDisplayName} variant="featured" />
        </div>
        <button
          className="store-action-btn store-action-btn--lg"
          data-variant={isWorking ? "working" : isAdded ? "added" : "get"}
          disabled={isWorking}
          onClick={(e) => {
            e.stopPropagation()
            onAction()
          }}
        >
          {isWorking ? "Adding..." : isAdded ? "Added" : "Get"}
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

  const activeInstalls = installed.filter((m) => m.state === "installed")
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
          return (
            <div
              key={mod.installId}
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

type DiscoverFilter = "all" | "stella" | "agents"

const DISCOVER_FILTERS: Array<{ id: DiscoverFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "stella", label: "Stella" },
  { id: "agents", label: "Agents" },
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
}: {
  packages: StorePackageRecord[]
  installed: InstalledStoreModRecord[]
  installedMap: Map<string, InstalledStoreModRecord>
  loading: boolean
  error: string | null
  onSelect: (packageId: string) => void
  onInstall: (packageId: string) => Promise<void>
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
      const category = pkg.category ?? "stella"
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
          isWorking={working === featured.packageId}
          onAction={() => {
            if (installedMap.has(featured.packageId)) {
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
              const isAdded = installedMap.has(pkg.packageId)
              const isWorking = working === pkg.packageId
              return (
                <StoreCard
                  key={pkg.packageId}
                  pkg={pkg}
                  actionLabel={isWorking ? "Adding..." : isAdded ? "Added" : "Get"}
                  actionVariant={isWorking ? "working" : isAdded ? "added" : "get"}
                  actionDisabled={isAdded || isWorking}
                  meta={`Version ${pkg.latestReleaseNumber}`}
                  onAction={() => void handleInstall(pkg.packageId)}
                  onClick={() => onSelect(pkg.packageId)}
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
// Updates Tab
// ---------------------------------------------------------------------------

type UpdateEntry = {
  pkg: StorePackageRecord
  installed: InstalledStoreModRecord
}

function UpdatesTab({
  packages,
  installed,
  loading,
  error,
  onSelect,
  onUpdate,
}: {
  packages: StorePackageRecord[]
  installed: InstalledStoreModRecord[]
  loading: boolean
  error: string | null
  onSelect: (packageId: string) => void
  onUpdate: (packageId: string, releaseNumber: number) => Promise<void>
}) {
  const [working, setWorking] = useState<string | null>(null)

  const updates: UpdateEntry[] = useMemo(() => {
    const pkgMap = new Map<string, StorePackageRecord>()
    for (const pkg of packages) pkgMap.set(pkg.packageId, pkg)
    const result: UpdateEntry[] = []
    for (const mod of installed) {
      if (mod.state !== "installed") continue
      const pkg = pkgMap.get(mod.packageId)
      if (!pkg) continue
      if (pkg.latestReleaseNumber > mod.releaseNumber) {
        result.push({ pkg, installed: mod })
      }
    }
    return result.sort((a, b) => b.pkg.updatedAt - a.pkg.updatedAt)
  }, [packages, installed])

  const handleUpdate = useCallback(
    async (packageId: string, releaseNumber: number) => {
      setWorking(packageId)
      try {
        await onUpdate(packageId, releaseNumber)
      } finally {
        setWorking(null)
      }
    },
    [onUpdate],
  )

  // Updates is rendered as a section above the Installed library, so when
  // there's nothing to do we render nothing — no "all caught up" empty
  // state to clutter the page. Errors still surface so the user knows
  // why updates aren't loading.
  if (loading) return null

  if (error) {
    return (
      <div className="store-status" data-variant="error">
        {error}
      </div>
    )
  }

  if (updates.length === 0) return null

  return (
    <div className="store-section">
      <div className="store-section-header">
        <span className="store-section-title">Updates</span>
        <span className="store-section-count">{updates.length}</span>
      </div>
      <div className="store-update-list">
        {updates.map(({ pkg, installed: install }) => {
          const isWorking = working === pkg.packageId
          return (
            <div
              key={pkg.packageId}
              className="store-update-row"
              onClick={() => onSelect(pkg.packageId)}
            >
              <PackageArtwork
                iconUrl={pkg.iconUrl}
                name={pkg.displayName}
                className="store-update-art"
                letterClassName="store-update-art-letter"
              />
              <div className="store-update-body">
                <div className="store-update-name">{pkg.displayName}</div>
                <div className="store-update-version">
                  Version {pkg.latestReleaseNumber} · You have {install.releaseNumber}
                </div>
                <div className="store-update-notes">{pkg.description}</div>
              </div>
              <button
                className="store-action-btn"
                data-variant={isWorking ? "working" : "get"}
                disabled={isWorking}
                onClick={(e) => {
                  e.stopPropagation()
                  void handleUpdate(pkg.packageId, pkg.latestReleaseNumber)
                }}
              >
                {isWorking ? "Updating..." : "Update"}
              </button>
            </div>
          )
        })}
      </div>
    </div>
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
      <div className="store-grid">
        {connectors.map((connector) => {
          const ready = connector.executable === true
          const isWorking = working === connector.marketplaceKey
          // ConnectTab uses StoreCard but synthesizes a package-shaped object
          // — connectors don't have iconUrl yet; they fall back to gradient.
          const synthesized: StorePackageRecord = {
            packageId: connector.id,
            displayName: connector.displayName,
            description:
              connector.description ??
              connector.integrationPath ??
              "Connect this service to Stella.",
            latestReleaseNumber: 0,
            createdAt: 0,
            updatedAt: 0,
          }
          const interactive = ready && !connector.installed && !isWorking
          const trigger = () => void handleInstall(connector.marketplaceKey)
          return (
            <StoreCard
              key={connector.id}
              pkg={synthesized}
              actionLabel={
                isWorking
                  ? "Adding..."
                  : connector.installed
                    ? "Connected"
                    : ready
                      ? "Add"
                      : "Soon"
              }
              actionVariant={
                isWorking
                  ? "working"
                  : connector.installed
                    ? "added"
                    : ready
                      ? "subtle"
                      : "added"
              }
              actionDisabled={connector.installed || isWorking || !ready}
              onAction={trigger}
              onClick={interactive ? trigger : undefined}
            />
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
  installing,
  onConfirm,
  onCancel,
}: {
  connector: StellaConnectorSummary | null
  open: boolean
  installing: boolean
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
            disabled={installing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="large"
            className="pill-btn pill-btn--primary pill-btn--lg"
            onClick={onConfirm}
            disabled={installing}
          >
            {installing ? "Adding..." : "Add"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Publish flow
// ---------------------------------------------------------------------------

function buildPublishPrompt(commits: LocalGitCommitRecord[]): string {
  const lines: string[] = []
  if (commits.length === 1) {
    const single = commits[0]!
    lines.push("Publish this change to the Stella Store:")
    lines.push("")
    lines.push(`- ${single.shortHash} ${single.subject}`)
    if (single.body) {
      const trimmed = single.body.split("\n").slice(0, 4).join(" ")
      lines.push(`  ${trimmed}`)
    }
  } else {
    lines.push("Publish these changes to the Stella Store as one mod:")
    lines.push("")
    for (const commit of commits) {
      lines.push(`- ${commit.shortHash} ${commit.subject}`)
    }
  }
  return lines.join("\n")
}

function buildUpdatePrompt(pkg: StorePackageRecord): string {
  return [
    `Update my "${pkg.displayName}" Stella Store mod.`,
    "",
    `Package ID: ${pkg.packageId}`,
    `Current version: ${pkg.latestReleaseNumber}`,
    "",
    "Look at recent self-mod commits and the existing release history, pick the relevant changes for this mod, confirm with me if anything is ambiguous, then publish a new version.",
  ].join("\n")
}

type PublishDialogTarget = {
  commits: LocalGitCommitRecord[]
  existingPackage?: StorePackageRecord
}

function PublishReviewDialog({
  target,
  open,
  onCancel,
  onPublished,
}: {
  target: PublishDialogTarget | null
  open: boolean
  onCancel: () => void
  onPublished?: () => Promise<void> | void
}) {
  const [requestText, setRequestText] = useState("")
  const [draft, setDraft] = useState<StorePublishDraft | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) return
    setRequestText(
      target.existingPackage
        ? buildUpdatePrompt(target.existingPackage)
        : buildPublishPrompt(target.commits),
    )
    setDraft(null)
    setError(null)
    setPreparing(false)
    setPublishing(false)
  }, [target])

  const selectedCommitHashes = useMemo(
    () => target?.commits.map((commit) => commit.commitHash) ?? [],
    [target],
  )

  const handlePrepare = useCallback(async () => {
    if (!target) return
    const api = window.electronAPI?.store
    if (!api?.prepareCandidateRelease) return
    const trimmed = requestText.trim()
    if (!trimmed) {
      setError("Tell the Store agent what this should become.")
      return
    }
    try {
      setPreparing(true)
      setError(null)
      const nextDraft = await api.prepareCandidateRelease({
        requestText: trimmed,
        selectedCommitHashes,
        ...(target.existingPackage
          ? { existingPackageId: target.existingPackage.packageId }
          : {}),
      })
      setDraft(nextDraft)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't prepare this release")
    } finally {
      setPreparing(false)
    }
  }, [requestText, selectedCommitHashes, target])

  const handlePublish = useCallback(async () => {
    if (!target || !draft) return
    const api = window.electronAPI?.store
    if (!api?.publishPreparedRelease) return
    try {
      setPublishing(true)
      setError(null)
      const release = await api.publishPreparedRelease({
        requestText: requestText.trim(),
        selectedCommitHashes,
        ...(target.existingPackage
          ? { existingPackageId: target.existingPackage.packageId }
          : {}),
        draft,
      })
      showToast({
        title: `Published ${release.manifest.displayName}.`,
        variant: "success",
      })
      await onPublished?.()
      onCancel()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't publish this release")
      setPublishing(false)
    }
  }, [draft, onCancel, onPublished, requestText, selectedCommitHashes, target])

  const fileCount = draft
    ? new Set(draft.selectedChanges.flatMap((change) => change.files)).size
    : 0

  const isUpdate = Boolean(target?.existingPackage)
  const headline = isUpdate
    ? `Publish update to ${target!.existingPackage!.displayName}`
    : "Publish to Store"
  const subtext = isUpdate
    ? "Review the next version before it goes out."
    : "Review what the Store agent prepares before publishing."
  const submitLabel = isUpdate
    ? publishing
      ? "Publishing update..."
      : "Publish update"
    : publishing
      ? "Publishing..."
      : "Publish"

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}>
      <DialogContent fit className="credential-modal-content">
        <DialogCloseButton className="credential-modal-close" />
        <DialogBody className="credential-modal-body">
          <div className="credential-modal-hero">
            <div className="credential-modal-icon">
              <Package size={20} />
            </div>
            <DialogTitle className="credential-modal-headline">
              {headline}
            </DialogTitle>
            <DialogDescription className="credential-modal-sub">
              {subtext}
            </DialogDescription>
          </div>

          <div className="credential-modal-form">
            <TextField
              label="What should this be?"
              multiline
              rows={4}
              value={requestText}
              onChange={(event) => {
                setRequestText(event.target.value)
                setDraft(null)
              }}
              placeholder="Describe what this should become in the Store."
              autoFocus
            />

            {draft ? (
              <div className="store-publish-review">
                <div className="store-publish-review-top">
                  <div className="store-publish-review-heading">
                    {draft.iconUrl ? (
                      <PackageArtwork
                        iconUrl={draft.iconUrl}
                        name={draft.displayName}
                        className="store-update-art"
                        letterClassName="store-update-art-letter"
                      />
                    ) : null}
                    <div>
                      <div className="store-publish-review-title">
                        {draft.displayName}
                      </div>
                      <div className="store-publish-review-sub">
                        {draft.category === "agents" ? "Agent capability" : "Stella add-on"}
                        {" · Version "}
                        {draft.releaseNumber}
                        {draft.authorDisplayName ? ` · by ${draft.authorDisplayName}` : ""}
                      </div>
                    </div>
                  </div>
                  <span className="store-section-count">
                    {draft.commitHashes.length} changes
                  </span>
                </div>
                <div className="store-card-desc">{draft.description}</div>
                {draft.releaseNotes ? (
                  <div className="store-card-meta">{draft.releaseNotes}</div>
                ) : null}
                <div className="store-card-meta">
                  {fileCount === 1 ? "1 file included" : `${fileCount} files included`}
                </div>
                <div className="store-publish-change-list">
                  {draft.selectedChanges.map((change) => (
                    <div key={change.commitHash} className="store-publish-change">
                      {change.shortHash ? `${change.shortHash} ` : ""}
                      {change.subject}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {error ? <div className="credential-modal-error">{error}</div> : null}

            <div className="credential-modal-actions">
              <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                disabled={preparing || publishing}
                className="pill-btn pill-btn--lg credential-modal-cancel"
              >
                Cancel
              </Button>
              {!draft ? (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void handlePrepare()}
                  disabled={preparing}
                  className="pill-btn pill-btn--primary pill-btn--lg credential-modal-submit"
                >
                  {preparing ? "Preparing..." : "Prepare"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void handlePublish()}
                  disabled={publishing}
                  className="pill-btn pill-btn--primary pill-btn--lg credential-modal-submit"
                >
                  {submitLabel}
                </Button>
              )}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Your Mods tab — owned packages + recent uncommitted-to-mod changes
// ---------------------------------------------------------------------------

function describeFiles(commit: LocalGitCommitRecord): string {
  if (commit.fileCount === 0) return "Internal change"
  if (commit.fileCount === 1) return "1 file changed"
  return `${commit.fileCount} files changed`
}

function CommitRow({
  commit,
  selected,
  onToggle,
  onPublish,
}: {
  commit: LocalGitCommitRecord
  selected: boolean
  onToggle: () => void
  onPublish: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="store-commit-card" data-selected={selected || undefined}>
      <div className="store-commit-top">
        <label className="store-commit-label">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${commit.subject}`}
          />
          <span className="store-commit-subject">{commit.subject}</span>
        </label>
        <button
          className="store-action-btn"
          data-variant="share"
          onClick={(e) => {
            e.stopPropagation()
            onPublish()
          }}
        >
          Publish
        </button>
      </div>
      {commit.body ? (
        <div className="store-card-desc">
          {commit.body.split("\n").slice(0, 2).join(" ")}
        </div>
      ) : null}
      <div className="store-commit-meta">
        <span>{formatTimeAgo(commit.timestampMs)}</span>
        <span aria-hidden>·</span>
        <button
          type="button"
          className="store-commit-meta-button"
          disabled={commit.fileCount === 0}
          onClick={() => commit.fileCount > 0 && setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {describeFiles(commit)}
          {commit.fileCount > 0 ? (expanded ? " ▴" : " ▾") : ""}
        </button>
      </div>
      {expanded && commit.files.length > 0 ? (
        <div className="store-commit-files">
          {commit.files.join("\n")}
          {commit.fileCount > commit.files.length ? (
            <div>… and {commit.fileCount - commit.files.length} more</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function YourModsTab({
  packages,
  packagesLoading,
  packagesError,
  commits,
  commitsLoading,
  commitsError,
  onSelectPackage,
  onPublishUpdate,
  onOpenPublish,
}: {
  packages: StorePackageRecord[]
  packagesLoading: boolean
  packagesError: string | null
  commits: LocalGitCommitRecord[]
  commitsLoading: boolean
  commitsError: string | null
  onSelectPackage: (packageId: string) => void
  onPublishUpdate: (pkg: StorePackageRecord) => void
  onOpenPublish: (commits: LocalGitCommitRecord[]) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [recentExpanded, setRecentExpanded] = useState(true)

  const toggle = useCallback((commitHash: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(commitHash)) next.delete(commitHash)
      else next.add(commitHash)
      return next
    })
  }, [])

  const selectedCommits = useMemo(
    () => commits.filter((c) => selected.has(c.commitHash)),
    [commits, selected],
  )

  const ownedSorted = useMemo(
    () => packages.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    [packages],
  )

  if (packagesLoading) return <SkeletonGrid />
  if (packagesError) {
    return (
      <div className="store-status" data-variant="error">
        {packagesError}
      </div>
    )
  }

  const hasOwned = ownedSorted.length > 0
  const hasCommits = commits.length > 0

  return (
    <>
      <div className="store-section">
        <div className="store-section-header">
          <span className="store-section-title">Installed</span>
          <span className="store-section-count">{ownedSorted.length}</span>
        </div>

        {hasOwned ? (
          <div className="store-grid">
            {ownedSorted.map((pkg) => (
              <StoreCard
                key={pkg.packageId}
                pkg={pkg}
                actionLabel="Update"
                actionVariant="share"
                actionDisabled={false}
                meta={`Version ${pkg.latestReleaseNumber} · Updated ${formatTimeAgo(pkg.updatedAt)}`}
                onAction={() => onPublishUpdate(pkg)}
                onClick={() => onSelectPackage(pkg.packageId)}
              />
            ))}
          </div>
        ) : (
          <div className="store-mods-empty-block">
            <div className="store-mods-empty-title">Nothing published yet</div>
            <div className="store-mods-empty-desc">
              Ask Stella to customize itself, then publish those changes from the list below.
            </div>
          </div>
        )}
      </div>

      <div className="store-recent-changes">
        <div className="store-recent-changes-head">
          <button
            type="button"
            className="store-recent-changes-toggle"
            onClick={() => setRecentExpanded((v) => !v)}
            aria-expanded={recentExpanded}
          >
            {recentExpanded ? (
              <ChevronLeft
                size={14}
                className="store-recent-changes-chevron"
                data-expanded
              />
            ) : (
              <ChevronRight size={14} className="store-recent-changes-chevron" />
            )}
            Recent changes available to publish
            <span className="store-section-count">{commits.length}</span>
          </button>
          {selectedCommits.length > 0 ? (
            <button
              className="store-action-btn store-recent-changes-action"
              data-variant="share"
              onClick={() => onOpenPublish(selectedCommits)}
            >
              Publish {selectedCommits.length} selected
            </button>
          ) : null}
        </div>

        {recentExpanded ? (
          commitsLoading ? (
            <SkeletonGrid />
          ) : commitsError ? (
            <div className="store-status" data-variant="error">
              {commitsError}
            </div>
          ) : !hasCommits ? (
            <EmptyState
              icon={<Sparkles size={32} />}
              title="No recent changes"
              description="When Stella modifies itself, those changes show up here so you can package them."
            />
          ) : (
            <div className="store-recent-changes-list">
              {commits.map((commit) => (
                <CommitRow
                  key={commit.commitHash}
                  commit={commit}
                  selected={selected.has(commit.commitHash)}
                  onToggle={() => toggle(commit.commitHash)}
                  onPublish={() => onOpenPublish([commit])}
                />
              ))}
            </div>
          )
        ) : null}
      </div>
    </>
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
  onPublishUpdate,
}: {
  packageId: string
  installedMap: Map<string, InstalledStoreModRecord>
  onBack: () => void
  onInstall: (packageId: string) => Promise<void>
  onRemove: (packageId: string) => Promise<void>
  onPublishUpdate: (pkg: StorePackageRecord) => void
}) {
  const { pkg, releases, loading, error } = usePackageDetail(packageId)
  const [working, setWorking] = useState(false)
  const isAdded = installedMap.has(packageId)

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
          <AuthorChip name={pkg.authorDisplayName} variant="detail" />
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
            <button
              className="store-action-btn store-action-btn--lg"
              data-variant="share"
              onClick={() => onPublishUpdate(pkg)}
            >
              Publish update
            </button>
            {isAdded ? (
              <button
                className="store-action-btn store-action-btn--lg"
                data-variant={working ? "working" : "remove"}
                onClick={() => void handleRemove()}
                disabled={working}
              >
                {working ? "Removing..." : "Remove"}
              </button>
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
}

export function StoreView({ activeTab: activeTabProp, onActiveTabChange }: StoreViewProps = {}) {
  useSelfModTaintMonitor()

  const [selectedTab, setSelectedTab] = useState<StoreTab>(DEFAULT_STORE_TAB)
  const tab = activeTabProp ?? selectedTab

  const handleTabClick = useCallback(
    (next: StoreTab) => {
      if (activeTabProp === undefined) setSelectedTab(next)
      onActiveTabChange?.(next)
    },
    [activeTabProp, onActiveTabChange],
  )

  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null)
  const [publishTarget, setPublishTarget] = useState<PublishDialogTarget | null>(null)
  const [credentialConnector, setCredentialConnector] =
    useState<StellaConnectorSummary | null>(null)
  const [confirmConnector, setConfirmConnector] =
    useState<StellaConnectorSummary | null>(null)
  const [confirmInstalling, setConfirmInstalling] = useState(false)

  const {
    packages,
    installed,
    installedMap,
    loading: packagesLoading,
    error: packagesError,
    reload: reloadPackages,
  } = useStorePackages()

  const {
    commits,
    loading: commitsLoading,
    error: commitsError,
  } = useLocalCommits()

  const {
    connectors,
    loading: connectorsLoading,
    error: connectorsError,
    reload: reloadConnectors,
  } = useStoreConnectors()

  const handleInstall = useCallback(
    async (packageId: string, releaseNumber?: number) => {
      const api = window.electronAPI?.store
      if (!api) return
      try {
        await api.installRelease({ packageId, ...(releaseNumber ? { releaseNumber } : {}) })
        showToast({ title: "Added to Stella!", variant: "success" })
        await reloadPackages()
      } catch (err) {
        showToast({
          title:
            err instanceof Error ? err.message : "Couldn't add this right now",
          variant: "error",
        })
      }
    },
    [reloadPackages],
  )

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

  const handlePublishUpdate = useCallback(
    (pkg: StorePackageRecord) => {
      if (commits.length === 0) {
        showToast({
          title: "No recent changes are available to publish.",
          variant: "error",
        })
        return
      }
      setPublishTarget({ commits, existingPackage: pkg })
    },
    [commits],
  )

  const handleOpenPublish = useCallback(
    (target: LocalGitCommitRecord[]) => {
      if (target.length === 0) return
      setPublishTarget({ commits: target })
    },
    [],
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

  const handleConfirmInstallConnector = useCallback(async () => {
    if (!confirmConnector) return
    const api = window.electronAPI?.store
    if (!api?.installConnector) return
    try {
      setConfirmInstalling(true)
      await api.installConnector(confirmConnector.marketplaceKey)
      setConfirmConnector(null)
      showToast({ title: "Connector added to Stella.", variant: "success" })
      await reloadConnectors()
    } catch (err) {
      showToast({
        title:
          err instanceof Error ? err.message : "Couldn't add this connector",
        variant: "error",
      })
    } finally {
      setConfirmInstalling(false)
    }
  }, [confirmConnector, reloadConnectors])

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
        installing={confirmInstalling}
        onConfirm={() => void handleConfirmInstallConnector()}
        onCancel={() =>
          confirmInstalling ? undefined : setConfirmConnector(null)
        }
      />
      <PublishReviewDialog
        open={publishTarget !== null}
        target={publishTarget}
        onCancel={() => setPublishTarget(null)}
        onPublished={reloadPackages}
      />
    </>
  )

  const groupedTabs: Array<{ group: StoreTabGroup; tabs: typeof STORE_TABS }> = STORE_TAB_GROUP_ORDER
    .map((group) => ({
      group,
      tabs: STORE_TABS.filter((entry) => entry.group === group),
    }))
    .filter((entry) => entry.tabs.length > 0)

  return (
    <>
      <PageSidebar title="Store">
        {groupedTabs.map(({ group, tabs }) => (
          <div key={group} className="sidebar-page-section">
            <div className="sidebar-section-label">
              {STORE_TAB_GROUP_LABELS[group]}
            </div>
            {tabs.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`sidebar-nav-item${tab === entry.key ? " sidebar-nav-item--active" : ""}`}
                onClick={() => handleTabClick(entry.key)}
              >
                <span className="sidebar-nav-label">{entry.label}</span>
              </button>
            ))}
          </div>
        ))}
      </PageSidebar>

      <div className="store-root" data-tab={selectedPackageId ? "discover" : tab}>
        <div className="store-scroll">
          {selectedPackageId ? (
            <PackageDetailView
              packageId={selectedPackageId}
              installedMap={installedMap}
              onBack={() => setSelectedPackageId(null)}
              onInstall={handleInstall}
              onRemove={handleRemove}
              onPublishUpdate={handlePublishUpdate}
            />
          ) : tab === "discover" ? (
            <>
              <DiscoverTab
                packages={packages}
                installed={installed}
                installedMap={installedMap}
                loading={packagesLoading}
                error={packagesError}
                onSelect={setSelectedPackageId}
                onInstall={handleInstall}
              />
              <ConnectTab
                connectors={connectors}
                loading={connectorsLoading}
                error={connectorsError}
                onInstall={handleInstallConnector}
              />
            </>
          ) : tab === "fashion" ? (
            <FashionTab />
          ) : (
            <>
              <UpdatesTab
                packages={packages}
                installed={installed}
                loading={packagesLoading}
                error={packagesError}
                onSelect={setSelectedPackageId}
                onUpdate={handleInstall}
              />
              <YourModsTab
                packages={packages}
                packagesLoading={packagesLoading}
                packagesError={packagesError}
                commits={commits}
                commitsLoading={commitsLoading}
                commitsError={commitsError}
                onSelectPackage={setSelectedPackageId}
                onPublishUpdate={handlePublishUpdate}
                onOpenPublish={handleOpenPublish}
              />
            </>
          )}
        </div>

        {dialogs}
      </div>
    </>
  )
}

export default StoreView
