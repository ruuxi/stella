import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import type {
  SelfModFeatureRecord,
  StorePackageRecord,
  StorePackageReleaseRecord,
  InstalledStoreModRecord,
  StoreReleaseDraft,
} from "@/shared/types/electron"
import { showToast } from "@/ui/toast"
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left"
import Clock from "lucide-react/dist/esm/icons/clock"
import Layers from "lucide-react/dist/esm/icons/layers"
import Sparkles from "lucide-react/dist/esm/icons/sparkles"
import Package from "lucide-react/dist/esm/icons/package"
import "./store.css"

// ---------------------------------------------------------------------------
// Helpers
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
  for (const ch of value) {
    h = ((h << 5) - h + ch.charCodeAt(0)) | 0
  }
  return Math.abs(h)
}

function getGradient(name: string): string {
  return GRADIENTS[hashString(name) % GRADIENTS.length]
}

function getInitial(name: string): string {
  return (name.trim()[0] ?? "S").toUpperCase()
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "creation"
  )
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
      setError(err instanceof Error ? err.message : "Something went wrong")
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

function useStoreFeatures() {
  const api = useStoreApi()
  const [features, setFeatures] = useState<SelfModFeatureRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) {
      setLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const result = await api.listSelfModFeatures()
        if (!cancelled) {
          setFeatures(result)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Something went wrong")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api])

  return { features, loading, error }
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
          setError(err instanceof Error ? err.message : "Something went wrong")
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
// Placeholder Image
// ---------------------------------------------------------------------------

function PlaceholderImage({
  name,
  className,
  letterClassName,
}: {
  name: string
  className?: string
  letterClassName?: string
}) {
  return (
    <div
      className={className}
      style={{ background: getGradient(name) }}
    >
      <span className={letterClassName}>{getInitial(name)}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skeleton
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

// ---------------------------------------------------------------------------
// Empty States
// ---------------------------------------------------------------------------

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
// Store Card
// ---------------------------------------------------------------------------

function StoreCard({
  name,
  description,
  actionLabel,
  actionVariant,
  actionDisabled,
  meta,
  onAction,
  onClick,
}: {
  name: string
  description: string
  actionLabel: string
  actionVariant: string
  actionDisabled?: boolean
  meta?: string
  onAction?: () => void
  onClick?: () => void
}) {
  return (
    <div className="store-card" onClick={onClick}>
      <PlaceholderImage
        name={name}
        className="store-card-image"
        letterClassName="store-card-image-letter"
      />
      <div className="store-card-body">
        <div className="store-card-top">
          <span className="store-card-name">{name}</span>
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
        <div className="store-card-desc">{description}</div>
        {meta && <div className="store-card-meta">{meta}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Featured Card
// ---------------------------------------------------------------------------

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
      <div className="store-featured-overlay" />
      <div className="store-featured-content">
        <div className="store-featured-text">
          <div className="store-featured-label">Featured</div>
          <div className="store-featured-name">{pkg.displayName}</div>
          <div className="store-featured-desc">{pkg.description}</div>
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

// ---------------------------------------------------------------------------
// Added-to-Stella Row
// ---------------------------------------------------------------------------

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
              <div
                className="store-added-chip-icon"
                style={{ background: getGradient(name) }}
              >
                <span className="store-added-chip-letter">
                  {getInitial(name)}
                </span>
              </div>
              <span className="store-added-chip-name">{name}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
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

  const featured = packages[0]
  const rest = packages.slice(1)
  const featuredIsAdded = installedMap.has(featured.packageId)
  const featuredIsWorking = working === featured.packageId

  return (
    <>
      <FeaturedCard
        pkg={featured}
        isAdded={featuredIsAdded}
        isWorking={featuredIsWorking}
        onAction={() => {
          if (featuredIsAdded) {
            onSelect(featured.packageId)
            return
          }
          void handleInstall(featured.packageId)
        }}
        onClick={() => onSelect(featured.packageId)}
      />

      <AddedRow
        installed={installed}
        packages={packages}
        onSelect={onSelect}
      />

      {rest.length > 0 && (
        <div className="store-section">
          <div className="store-section-header">
            <span className="store-section-title">All Add-ons</span>
            <span className="store-section-count">{packages.length}</span>
          </div>
          <div className="store-grid">
            {rest.map((pkg) => {
              const isAdded = installedMap.has(pkg.packageId)
              const isWorking = working === pkg.packageId
              return (
                <StoreCard
                  key={pkg.packageId}
                  name={pkg.displayName}
                  description={pkg.description}
                  actionLabel={
                    isWorking ? "Adding..." : isAdded ? "Added" : "Get"
                  }
                  actionVariant={
                    isWorking ? "working" : isAdded ? "added" : "get"
                  }
                  actionDisabled={isAdded || isWorking}
                  meta={`Version ${pkg.latestReleaseNumber}`}
                  onAction={() => void handleInstall(pkg.packageId)}
                  onClick={() => onSelect(pkg.packageId)}
                />
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Share Flow
// ---------------------------------------------------------------------------

function ShareFlow({
  feature,
  onDone,
  onCancel,
}: {
  feature: SelfModFeatureRecord
  onDone: () => void
  onCancel: () => void
}) {
  const api = useStoreApi()
  const [draft, setDraft] = useState<StoreReleaseDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [notes, setNotes] = useState("")
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    if (!api) return
    let cancelled = false
    void (async () => {
      try {
        const result = await api.getReleaseDraft({
          featureId: feature.featureId,
        })
        if (!cancelled) {
          setDraft(result)
          setName(result.displayName)
          setDescription(result.description)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "This creation can't be shared right now",
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, feature.featureId])

  const handleShare = useCallback(async () => {
    if (!api || !draft || sharing) return
    setSharing(true)
    setError(null)
    try {
      const packageId =
        draft.packageId || feature.packageId || slugify(name || feature.name)
      await api.publishRelease({
        featureId: feature.featureId,
        packageId,
        displayName: name.trim() || feature.name,
        description: description.trim() || feature.description,
        releaseNotes: notes.trim() || undefined,
        batchIds: draft.selectedBatchIds,
      })
      showToast({ title: "Shared successfully!", variant: "success" })
      onDone()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong",
      )
    } finally {
      setSharing(false)
    }
  }, [api, draft, feature, name, description, notes, sharing, onDone])

  if (loading) {
    return (
      <div className="store-share-form">
        <div className="store-share-heading">Preparing...</div>
        <div className="store-skeleton-line" />
        <div className="store-skeleton-line store-skeleton-line--short" />
      </div>
    )
  }

  if (error && !draft) {
    return (
      <div className="store-share-form">
        <div className="store-status" data-variant="error">
          {error}
        </div>
        <div className="store-share-actions">
          <button
            className="store-action-btn"
            data-variant="added"
            onClick={onCancel}
          >
            Close
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="store-share-form">
      <div className="store-share-heading">Share with others</div>

      {error && (
        <div className="store-status" data-variant="error">
          {error}
        </div>
      )}

      <div className="store-share-field">
        <label className="store-share-label">Name</label>
        <input
          className="store-share-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What should it be called?"
        />
      </div>

      <div className="store-share-field">
        <label className="store-share-label">Description</label>
        <textarea
          className="store-share-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe it briefly"
        />
      </div>

      <div className="store-share-field">
        <label className="store-share-label">What's new (optional)</label>
        <input
          className="store-share-input"
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Describe what changed in this version"
        />
      </div>

      <div className="store-share-actions">
        <button
          className="store-action-btn"
          data-variant="added"
          onClick={onCancel}
          disabled={sharing}
        >
          Cancel
        </button>
        <button
          className="store-action-btn"
          data-variant={sharing ? "working" : "get"}
          onClick={() => void handleShare()}
          disabled={sharing || !name.trim()}
        >
          {sharing ? "Sharing..." : "Share"}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// My Creations Tab
// ---------------------------------------------------------------------------

function CreationsTab({
  features,
  loading,
  error,
}: {
  features: SelfModFeatureRecord[]
  loading: boolean
  error: string | null
}) {
  const [sharingFeatureId, setSharingFeatureId] = useState<string | null>(null)

  if (loading) return <SkeletonGrid />

  if (error) {
    return (
      <div className="store-status" data-variant="error">
        {error}
      </div>
    )
  }

  if (features.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles size={32} />}
        title="No creations yet"
        description="Ask Stella to customize your experience, and your creations will appear here."
      />
    )
  }

  return (
    <div className="store-section">
      <div className="store-section-header">
        <span className="store-section-title">Your Creations</span>
        <span className="store-section-count">{features.length}</span>
      </div>

      {sharingFeatureId && (
        <ShareFlow
          feature={features.find((f) => f.featureId === sharingFeatureId)!}
          onDone={() => setSharingFeatureId(null)}
          onCancel={() => setSharingFeatureId(null)}
        />
      )}

      <div className="store-grid">
        {features.map((feature) => {
          const isShared = Boolean(feature.packageId)
          return (
            <StoreCard
              key={feature.featureId}
              name={feature.name}
              description={feature.description}
              actionLabel={isShared ? "Shared" : "Share"}
              actionVariant={isShared ? "shared" : "share"}
              meta={formatTimeAgo(feature.updatedAt)}
              onAction={() => setSharingFeatureId(feature.featureId)}
            />
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Package Detail View
// ---------------------------------------------------------------------------

function PackageDetailView({
  packageId,
  installedMap,
  onBack,
  onInstall,
  onRemove,
}: {
  packageId: string
  installedMap: Map<string, InstalledStoreModRecord>
  onBack: () => void
  onInstall: (packageId: string) => Promise<void>
  onRemove: (packageId: string) => Promise<void>
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

  return (
    <div className="store-detail">
      <button className="store-detail-back" onClick={onBack}>
        <ChevronLeft size={16} />
        Back
      </button>

      <div className="store-detail-hero">
        <PlaceholderImage
          name={pkg.displayName}
          className="store-detail-image"
          letterClassName="store-detail-image-letter"
        />
        <div className="store-detail-info">
          <div className="store-detail-name">{pkg.displayName}</div>
          <div className="store-detail-desc">{pkg.description}</div>
          <div className="store-detail-meta">
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

      {releases.length > 0 && (
        <>
          <hr className="store-detail-divider" />
          <div className="store-detail-section">
            <div className="store-detail-section-title">Version History</div>
            <div className="store-version-list">
              {releases.map((release) => {
                const notes = getReleaseNotes(release)
                const fileCount = getFileCount(release)
                return (
                  <div key={release.releaseNumber} className="store-version-item">
                    <div className="store-version-label">
                      Version {release.releaseNumber}
                    </div>
                    {notes && (
                      <div className="store-version-notes">{notes}</div>
                    )}
                    <div className="store-version-date">
                      {formatDate(release.createdAt)}
                      {fileCount > 0 && ` \u00B7 ${fileCount} items customized`}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Store View (main export)
// ---------------------------------------------------------------------------

type StoreTab = "discover" | "creations"

export function StoreView() {
  const [tab, setTab] = useState<StoreTab>("discover")
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null)
  const [scrolled, setScrolled] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onScroll = () => setScrolled(el.scrollTop > 4)
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  const {
    packages,
    installed,
    installedMap,
    loading: packagesLoading,
    error: packagesError,
    reload: reloadPackages,
  } = useStorePackages()

  const {
    features,
    loading: featuresLoading,
    error: featuresError,
  } = useStoreFeatures()

  const handleInstall = useCallback(
    async (packageId: string) => {
      const api = window.electronAPI?.store
      if (!api) return
      try {
        await api.installRelease({ packageId })
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

  // Detail view
  if (selectedPackageId) {
    return (
      <div className="store-root" ref={rootRef}>
        <div className="store-scroll">
          <PackageDetailView
            packageId={selectedPackageId}
            installedMap={installedMap}
            onBack={() => setSelectedPackageId(null)}
            onInstall={handleInstall}
            onRemove={handleRemove}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="store-root" ref={rootRef}>
      <div className="store-header" data-scrolled={scrolled || undefined}>
        <div className="store-header-inner">
          <h1 className="store-title">Store</h1>
          <div className="store-tabs">
            <button
              className="store-tab"
              data-active={tab === "discover" || undefined}
              onClick={() => setTab("discover")}
            >
              Discover
            </button>
            <button
              className="store-tab"
              data-active={tab === "creations" || undefined}
              onClick={() => setTab("creations")}
            >
              My Creations
            </button>
          </div>
        </div>
      </div>

      <div className="store-scroll">
        {tab === "discover" ? (
          <DiscoverTab
            packages={packages}
            installed={installed}
            installedMap={installedMap}
            loading={packagesLoading}
            error={packagesError}
            onSelect={setSelectedPackageId}
            onInstall={handleInstall}
          />
        ) : (
          <CreationsTab
            features={features}
            loading={featuresLoading}
            error={featuresError}
          />
        )}
      </div>
    </div>
  )
}

export default StoreView
