import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  InstalledStoreModRecord,
  LocalGitCommitRecord,
} from "@/shared/types/electron"
import { showToast } from "@/ui/toast"
import { dispatchStellaSendMessage } from "@/shared/lib/stella-send-message"
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left"
import Clock from "lucide-react/dist/esm/icons/clock"
import Layers from "lucide-react/dist/esm/icons/layers"
import Sparkles from "lucide-react/dist/esm/icons/sparkles"
import Package from "lucide-react/dist/esm/icons/package"
import { useSelfModTaintMonitor } from "@/systems/boot/use-self-mod-taint-monitor"
import { FashionTab } from "./fashion/FashionTab"
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

// The Store catalog calls reach Convex through the Electron runtime. When the
// renderer hasn't connected an account yet (or the runtime simply doesn't have
// a Convex deployment URL set), those calls reject with messages like
// "Authentication required" or "Not connected to Convex. Sign in or set
// STELLA_CONVEX_URL.". Surfacing the raw text reads as "you must log in to
// browse the Store", which we explicitly want to avoid — fall back to the
// empty-state instead.
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

/**
 * Flat list of recent self-mod commits surfaced from the runtime. Each
 * commit is one agent-authored change to Stella's own code (renderer,
 * runtime, electron, etc.). The Store agent uses this list (plus git
 * history + the original conversation) to assemble a publishable release.
 */
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
// Publish prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the canned prompt the Publish button hands off to the orchestrator.
 *
 * The orchestrator recognizes the publish framing and routes it to the
 * Store specialist via its `Store({ prompt })` tool. The prompt is plain
 * user-voice: which commits the user picked, with shape (single / multi /
 * update). The Store agent is the one that loads git, confirms metadata,
 * and publishes — so we deliberately don't over-spec the workflow here.
 */
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

// ---------------------------------------------------------------------------
// My Creations Tab — flat commit list
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
    <div
      className="store-card"
      data-store-commit
      data-selected={selected || undefined}
    >
      <div className="store-card-body">
        <div className="store-card-top">
          <label
            className="store-card-name"
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              aria-label={`Select ${commit.subject}`}
            />
            <span>{commit.subject}</span>
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
        {commit.body && (
          <div className="store-card-desc">
            {commit.body.split("\n").slice(0, 2).join(" ")}
          </div>
        )}
        <div
          className="store-card-meta"
          style={{ display: "flex", alignItems: "center", gap: 12 }}
        >
          <span>{formatTimeAgo(commit.timestampMs)}</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            className="store-card-meta"
            style={{
              background: "transparent",
              border: 0,
              padding: 0,
              cursor: commit.fileCount > 0 ? "pointer" : "default",
              color: "inherit",
            }}
            onClick={() => commit.fileCount > 0 && setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {describeFiles(commit)}
            {commit.fileCount > 0 && (expanded ? " ▴" : " ▾")}
          </button>
        </div>
        {expanded && commit.files.length > 0 && (
          <div
            className="store-card-meta"
            style={{
              marginTop: 6,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
              fontSize: 11,
              lineHeight: 1.5,
              opacity: 0.75,
              wordBreak: "break-all",
            }}
          >
            {commit.files.join("\n")}
            {commit.fileCount > commit.files.length && (
              <div>… and {commit.fileCount - commit.files.length} more</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CreationsTab({
  commits,
  loading,
  error,
}: {
  commits: LocalGitCommitRecord[]
  loading: boolean
  error: string | null
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const toggle = useCallback((commitHash: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(commitHash)) {
        next.delete(commitHash)
      } else {
        next.add(commitHash)
      }
      return next
    })
  }, [])

  const handlePublish = useCallback(
    (target: LocalGitCommitRecord[]) => {
      if (target.length === 0) return
      const prompt = buildPublishPrompt(target)
      dispatchStellaSendMessage({
        text: prompt,
        triggerKind: "store_publish_request",
        triggerSource: "store_view",
      })
      showToast({
        title:
          target.length === 1
            ? "Asked Stella to help publish this change."
            : `Asked Stella to help publish ${target.length} changes.`,
        variant: "success",
      })
      setSelected(new Set())
    },
    [],
  )

  if (loading) return <SkeletonGrid />

  if (error) {
    return (
      <div className="store-status" data-variant="error">
        {error}
      </div>
    )
  }

  if (commits.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles size={32} />}
        title="No creations yet"
        description="Ask Stella to customize your experience, and the changes will show up here."
      />
    )
  }

  const selectedCommits = commits.filter((c) => selected.has(c.commitHash))

  return (
    <div className="store-section">
      <div
        className="store-section-header"
        style={{ display: "flex", alignItems: "center", gap: 12 }}
      >
        <span className="store-section-title">Your Creations</span>
        <span className="store-section-count">{commits.length}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            className="store-action-btn"
            data-variant={selectedCommits.length > 0 ? "share" : "added"}
            disabled={selectedCommits.length === 0}
            onClick={() => handlePublish(selectedCommits)}
          >
            Publish selected
            {selectedCommits.length > 0 ? ` (${selectedCommits.length})` : ""}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {commits.map((commit) => (
          <CommitRow
            key={commit.commitHash}
            commit={commit}
            selected={selected.has(commit.commitHash)}
            onToggle={() => toggle(commit.commitHash)}
            onPublish={() => handlePublish([commit])}
          />
        ))}
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

type StoreTab = "discover" | "fashion" | "creations"

export function StoreView() {
  useSelfModTaintMonitor()

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
    commits,
    loading: commitsLoading,
    error: commitsError,
  } = useLocalCommits()

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

  const handlePublishUpdate = useCallback((pkg: StorePackageRecord) => {
    dispatchStellaSendMessage({
      text: buildUpdatePrompt(pkg),
      triggerKind: "store_publish_request",
      triggerSource: "store_view",
    })
    showToast({
      title: `Asked Stella to update ${pkg.displayName}.`,
      variant: "success",
    })
  }, [])

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
            onPublishUpdate={handlePublishUpdate}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="store-root" ref={rootRef} data-tab={tab}>
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
              data-active={tab === "fashion" || undefined}
              onClick={() => setTab("fashion")}
            >
              Fashion
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
        ) : tab === "fashion" ? (
          <FashionTab />
        ) : (
          <CreationsTab
            commits={commits}
            loading={commitsLoading}
            error={commitsError}
          />
        )}
      </div>
    </div>
  )
}

export default StoreView
