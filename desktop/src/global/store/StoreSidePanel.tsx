/**
 * Store side panel — the entire publish UX.
 *
 * Rendered inside the workspace panel as the Store display tab. There
 * is no separate Publish page or chat surface; this panel is what the
 * user interacts with to ship add-ons.
 *
 * Layout:
 *   - Top: linear list of "things to publish" — feature groups
 *     (collapsed Stella self-mod commits) + installed add-ons +
 *     installed-add-ons-with-update. One row per logical thing,
 *     sorted by recency. Click toggles selection.
 *   - Bottom (when in Idle with >=1 selection): action button labeled
 *     "Publish" or "Update" depending on the selection shape.
 *   - Bottom (Working / Pick / Draft / Done): state-machine view
 *     replaces the action area. State derives from the persisted
 *     Convex thread, so the panel stays correct across refreshes.
 */
import { useCallback, useEffect, useMemo } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/api";
import type {
  InstalledStoreModRecord,
  StorePackageRecord,
  StoreThreadCommitCatalogEntry,
  StoreThreadFeatureRosterEntry,
} from "@/shared/types/electron";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import {
  refreshFeatureRoster,
  storeSidePanelStore,
  useStoreSidePanelState,
} from "./store-side-panel-store";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function describeFiles(fileCount: number): string {
  if (fileCount === 0) return "Internal change";
  if (fileCount === 1) return "1 file";
  return `${fileCount} files`;
}

// ---------------------------------------------------------------------------
// Linear list shape
//
// Three row "kinds" but rendered identically — only the badge differs.
// Sorted by `sortMs` desc, oldest at the bottom.
// ---------------------------------------------------------------------------

type LinearRowBase = {
  /** Unique key for selection + React. */
  key: string;
  title: string;
  badge: string;
  fileCount: number;
  sortMs: number;
};

type FeatureRow = LinearRowBase & {
  kind: "feature";
  featureId: string;
  /**
   * Convenience copy: which commit hashes belong to this feature group.
   * Only populated for unpublished groups; published features point at
   * their existing add-on instead.
   */
  commitHashes: string[];
};

type InstalledRow = LinearRowBase & {
  kind: "installed";
  packageId: string;
  /** True when a newer release is available for this installed add-on. */
  hasUpdate: boolean;
  latestReleaseNumber: number;
  installedReleaseNumber: number;
};

type LinearRow = FeatureRow | InstalledRow;

const buildLinearRows = (args: {
  features: StoreThreadFeatureRosterEntry[];
  /**
   * Every package the panel knows about — owned by the current user
   * *and* public lookups for installed-from-other-creators add-ons.
   * Author bylines on the installed rows distinguish them.
   */
  packages: StorePackageRecord[];
  /** Just the user's owned packageIds — used to label rows correctly. */
  ownedPackageIds: Set<string>;
  installedMods: InstalledStoreModRecord[];
}): LinearRow[] => {
  const rows: LinearRow[] = [];

  const packageByPackageId = new Map<string, StorePackageRecord>();
  for (const pkg of args.packages) packageByPackageId.set(pkg.packageId, pkg);
  const ownedByPackageId = new Map<string, StorePackageRecord>();
  for (const pkg of args.packages) {
    if (args.ownedPackageIds.has(pkg.packageId)) {
      ownedByPackageId.set(pkg.packageId, pkg);
    }
  }

  // Track which *packages* already appeared as an owned-feature row
  // (`feature.publishedPackageId`). When the same packageId also shows
  // up in `installedMods` (e.g. the user installed their own published
  // add-on), we skip the installed row to avoid double-listing — but
  // only for that specific package, not for every installed add-on.
  const publishedPackageIds = new Set<string>();

  for (const feature of args.features) {
    if (feature.publishedPackageId) {
      publishedPackageIds.add(feature.publishedPackageId);
      const pkg = ownedByPackageId.get(feature.publishedPackageId);
      const versionLabel = pkg?.latestReleaseNumber
        ? ` · v${pkg.latestReleaseNumber}`
        : "";
      const badge = `By you${versionLabel}`;
      rows.push({
        kind: "feature",
        key: `feature:${feature.featureId}`,
        featureId: feature.featureId,
        commitHashes: [],
        title: pkg?.displayName ?? feature.latestTitle,
        badge,
        fileCount: feature.fileFingerprint.length,
        sortMs: feature.lastSeenMs,
      });
      continue;
    }

    const parents = feature.parentPackageIds.filter(Boolean);
    let badge = "By you";
    if (parents.length > 0) {
      const firstParent =
        ownedByPackageId.get(parents[0]!)?.displayName ?? parents[0]!;
      badge =
        parents.length === 1
          ? `By you · built on ${firstParent}`
          : `By you · built on ${firstParent} +${parents.length - 1}`;
    }

    rows.push({
      kind: "feature",
      key: `feature:${feature.featureId}`,
      featureId: feature.featureId,
      commitHashes: [], // server reconstructs from featureId
      title: feature.latestTitle,
      badge,
      fileCount: feature.fileFingerprint.length,
      sortMs: feature.lastSeenMs,
    });
  }

  // Installed add-ons not owned by the user (i.e. installed from someone
  // else's release) get their own row. Owned + published features already
  // showed up above as "By you · v3" rows.
  const installedByPackageId = new Map<string, InstalledStoreModRecord>();
  for (const mod of args.installedMods) {
    if (mod.state !== "installed") continue;
    installedByPackageId.set(mod.packageId, mod);
  }
  for (const mod of installedByPackageId.values()) {
    const pkg = packageByPackageId.get(mod.packageId);
    const isOwnedByUser = args.ownedPackageIds.has(mod.packageId);
    if (isOwnedByUser && publishedPackageIds.has(mod.packageId)) {
      // This installed add-on is already represented above as a
      // "By you · vN" feature row. Other owned-but-not-yet-published
      // installs still render here so the user can update them.
      continue;
    }
    const hasUpdate =
      Boolean(pkg) && pkg!.latestReleaseNumber > mod.releaseNumber;
    const authorName = isOwnedByUser
      ? "you"
      : pkg?.authorDisplayName ?? pkg?.authorHandle ?? "another creator";
    const badge = pkg
      ? hasUpdate
        ? `By ${authorName} · update available`
        : `By ${authorName}`
      : `Installed v${mod.releaseNumber}`;
    rows.push({
      kind: "installed",
      key: `installed:${mod.packageId}`,
      packageId: mod.packageId,
      hasUpdate,
      latestReleaseNumber: pkg?.latestReleaseNumber ?? mod.releaseNumber,
      installedReleaseNumber: mod.releaseNumber,
      title: pkg?.displayName ?? mod.packageId,
      badge,
      fileCount: 0,
      sortMs: pkg?.updatedAt ?? mod.updatedAt,
    });
  }

  rows.sort((a, b) => b.sortMs - a.sortMs);
  return rows;
};

// ---------------------------------------------------------------------------
// State machine derived from Convex thread
// ---------------------------------------------------------------------------

type DraftPayload = {
  packageId: string;
  category: "agents" | "stella";
  displayName: string;
  description: string;
  releaseNotes?: string;
  releaseNumber: number;
  existingPackageId?: string;
  commitHashes: string[];
  selectedChanges: Array<{
    commitHash: string;
    shortHash: string;
    subject: string;
    files: string[];
  }>;
  publishedAt?: number;
  publishedReleaseNumber?: number;
  cancelledAt?: number;
};

type CandidatesPayload = {
  reason: string;
  commitHashes: string[];
  resolvedAt?: number;
  resolvedCommitHashes?: string[];
};

type ThreadMessage = {
  _id: string;
  role: "user" | "assistant" | "draft" | "candidates";
  text: string;
  pending?: boolean;
  draftPayload?: DraftPayload;
  candidatesPayload?: CandidatesPayload;
};

type ThreadResult = {
  threadId: string | null;
  messages: ThreadMessage[];
};

type Phase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "pick"; messageId: string; payload: CandidatesPayload }
  | { kind: "draft"; messageId: string; payload: DraftPayload }
  | { kind: "done"; payload: DraftPayload };

/**
 * How long the "Published …" card stays visible before the panel
 * returns to idle. Without a time bound, a successful publish would
 * keep deriving `done` forever and the action area would never come
 * back, blocking subsequent publishes from the same panel session.
 */
const DONE_PHASE_WINDOW_MS = 60_000;

const derivePhase = (messages: ThreadMessage[], nowMs: number): Phase => {
  // Walk newest-first looking for the first row that defines the phase.
  // Rules in priority order:
  //   - pending assistant row -> Working
  //   - unresolved draft -> Draft
  //   - just-published draft (within the done window) -> Done
  //   - unresolved candidates -> Pick
  //   - else -> Idle
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.pending) {
      return { kind: "working" };
    }
    if (message.role === "draft" && message.draftPayload) {
      const draft = message.draftPayload;
      if (draft.publishedAt) {
        if (nowMs - draft.publishedAt < DONE_PHASE_WINDOW_MS) {
          return { kind: "done", payload: draft };
        }
        // Stale published draft — keep walking older messages so a
        // pending assistant or unresolved draft further back doesn't
        // get masked. In the common case nothing earlier is actionable
        // and we fall through to idle.
        continue;
      }
      if (!draft.cancelledAt) {
        return { kind: "draft", messageId: message._id, payload: draft };
      }
    }
    if (
      message.role === "candidates"
      && message.candidatesPayload
      && !message.candidatesPayload.resolvedAt
    ) {
      return {
        kind: "pick",
        messageId: message._id,
        payload: message.candidatesPayload,
      };
    }
  }
  return { kind: "idle" };
};

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function LinearRowItem({
  row,
  selected,
  disabled,
  onToggle,
}: {
  row: LinearRow;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="store-side-panel-row"
      data-selected={selected || undefined}
      data-update={
        row.kind === "installed" && row.hasUpdate ? "true" : undefined
      }
      onClick={() => {
        if (disabled) return;
        onToggle();
      }}
      disabled={disabled}
    >
      <span className="store-side-panel-row-title">{row.title}</span>
      <span className="store-side-panel-row-meta">
        <span className="store-side-panel-row-badge">{row.badge}</span>
        <span className="store-side-panel-row-dot" aria-hidden>·</span>
        <span>{formatTimeAgo(row.sortMs)}</span>
        {row.fileCount > 0 ? (
          <>
            <span className="store-side-panel-row-dot" aria-hidden>·</span>
            <span>{describeFiles(row.fileCount)}</span>
          </>
        ) : null}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// State-machine bottom card
// ---------------------------------------------------------------------------

function WorkingCard() {
  return (
    <div className="store-side-panel-state-card" data-phase="working">
      <Sparkles size={14} className="store-side-panel-spinner" />
      <span>Stella is figuring this out…</span>
    </div>
  );
}

function PickCard({
  payload,
  onSubmit,
  busy,
}: {
  payload: CandidatesPayload;
  onSubmit: (picked: string[]) => void | Promise<void>;
  busy: boolean;
}) {
  // Hydrate commit metadata for the candidate hashes. The previous
  // implementation took a `catalog` prop from the parent that was always
  // empty, so the picker fell back to short hashes — exactly the
  // scenario where the user needs human-readable subjects to choose
  // from. Targeted lookup so this works for old commits too.
  const [subjectByHash, setSubjectByHash] = useStateMap<
    string,
    { subject: string; fileCount: number }
  >(() => new Map());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const api = window.electronAPI?.store;
      if (!api?.listLocalCommitsBySelector) return;
      try {
        const commits = await api.listLocalCommitsBySelector({
          commitHashes: payload.commitHashes,
        });
        if (cancelled) return;
        const next = new Map<string, { subject: string; fileCount: number }>();
        for (const commit of commits) {
          next.set(commit.commitHash, {
            subject: commit.subject,
            fileCount: commit.fileCount,
          });
        }
        setSubjectByHash(next);
      } catch {
        // soft-fail; UI falls back to short hashes
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [payload.commitHashes, setSubjectByHash]);

  // Initialize with everything checked — most users pick all anyway.
  const [picked, setPicked] = useStateMap<string, boolean>(() =>
    new Map(payload.commitHashes.map((hash) => [hash, true])),
  );

  // Reset selection whenever the candidate payload itself changes
  // (e.g. the agent presents a second checklist in the same mounted
  // session). Without this, `picked` keeps stale hashes from the
  // previous payload and Continue submits the wrong selection.
  useEffect(() => {
    setPicked(new Map(payload.commitHashes.map((hash) => [hash, true])));
  }, [payload.commitHashes, setPicked]);

  const allSelected = Array.from(picked.values()).every(Boolean);
  const anySelected = Array.from(picked.values()).some(Boolean);

  return (
    <div className="store-side-panel-state-card" data-phase="pick">
      <div className="store-side-panel-state-title">{payload.reason}</div>
      <div className="store-side-panel-pick-list">
        <label className="store-side-panel-pick-row store-side-panel-pick-row--all">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => {
              const next = new Map<string, boolean>();
              for (const hash of payload.commitHashes) next.set(hash, !allSelected);
              setPicked(next);
            }}
            disabled={busy}
          />
          <span>Select all</span>
        </label>
        {payload.commitHashes.map((hash) => {
          const entry = subjectByHash.get(hash);
          return (
            <label key={hash} className="store-side-panel-pick-row">
              <input
                type="checkbox"
                checked={picked.get(hash) ?? false}
                onChange={() => {
                  const next = new Map(picked);
                  next.set(hash, !(picked.get(hash) ?? false));
                  setPicked(next);
                }}
                disabled={busy}
              />
              <span className="store-side-panel-pick-label">
                {entry?.subject ?? hash.slice(0, 12)}
              </span>
            </label>
          );
        })}
      </div>
      <Button
        type="button"
        variant="primary"
        className="pill-btn pill-btn--primary pill-btn--lg"
        disabled={!anySelected || busy}
        onClick={() => {
          const next = Array.from(picked.entries())
            .filter(([, on]) => on)
            .map(([hash]) => hash);
          void onSubmit(next);
        }}
      >
        {busy ? "Working…" : "Continue"}
      </Button>
    </div>
  );
}

function DraftCard({
  payload,
  onConfirm,
  onCancel,
  busy,
}: {
  payload: DraftPayload;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="store-side-panel-state-card" data-phase="draft">
      <div className="store-side-panel-state-title">
        {payload.existingPackageId
          ? `Update for ${payload.displayName}`
          : `New add-on: ${payload.displayName}`}
      </div>
      <div className="store-side-panel-state-meta">
        Version {payload.releaseNumber} ·{" "}
        {payload.selectedChanges.length}
        {payload.selectedChanges.length === 1 ? " change" : " changes"}
      </div>
      <div className="store-side-panel-state-desc">{payload.description}</div>
      {payload.releaseNotes ? (
        <div className="store-side-panel-state-notes">{payload.releaseNotes}</div>
      ) : null}
      <div className="store-side-panel-state-actions">
        <Button
          type="button"
          variant="ghost"
          className="pill-btn pill-btn--lg"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          className="pill-btn pill-btn--primary pill-btn--lg"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy
            ? "Publishing…"
            : payload.existingPackageId
              ? "Publish update"
              : "Publish"}
        </Button>
      </div>
    </div>
  );
}

function DoneCard({ payload }: { payload: DraftPayload }) {
  return (
    <div className="store-side-panel-state-card" data-phase="done">
      <div className="store-side-panel-state-title">
        Published {payload.displayName} v
        {payload.publishedReleaseNumber ?? payload.releaseNumber}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

export function StoreSidePanel() {
  const {
    roster,
    rosterLoading,
    packages,
    installedMods,
    selectedFeatureIds,
    selectedInstalledPackageIds,
  } = useStoreSidePanelState();

  // `listMessages` is auth-required (server-side `requireUserId`).
  // Skip the subscription when the user has no Convex session so the
  // panel degrades gracefully if it's ever mounted signed-out (the
  // route-level mount guard already covers the normal path).
  const { hasSession } = useAuthSessionState();
  const thread = useQuery(
    api.data.store_thread.listMessages,
    hasSession ? {} : "skip",
  ) as ThreadResult | undefined;
  const sendMessage = useAction(api.data.store_thread.sendMessage);
  const confirmDraft = useAction(api.data.store_thread.confirmDraft);
  const cancelDraft = useMutation(api.data.store_thread.cancelDraft);
  const submitCandidatesPick = useMutation(
    api.data.store_thread.submitCandidatesPick,
  );

  // Initial roster load + cleanup on unmount.
  useEffect(() => {
    void refreshFeatureRoster();
    return () => {
      storeSidePanelStore.reset();
    };
  }, []);

  // Refresh installed mods + packages whenever the thread updates (a
  // publish or update touches both). Cheap; no telemetry.
  useEffect(() => {
    let cancelled = false;
    const reloadPkgs = async () => {
      const api = window.electronAPI?.store;
      if (!api) return;
      try {
        const [pkgs, mods] = await Promise.all([
          api.listPackages(),
          api.listInstalledMods(),
        ]);
        if (cancelled) return;
        storeSidePanelStore.setPackages(pkgs);
        storeSidePanelStore.setInstalledMods(mods);
      } catch {
        // soft-fail; UI handles empty arrays gracefully
      }
    };
    void reloadPkgs();
    return () => {
      cancelled = true;
    };
  }, [thread?.messages.length]);

  // `nowTick` advances when the current `done` window expires, forcing
  // a re-derive so the panel transitions back to idle on its own.
  const [nowTick, setNowTick] = useReactState(() => Date.now());
  const phase = useMemo<Phase>(
    () => derivePhase(thread?.messages ?? [], nowTick),
    [thread?.messages, nowTick],
  );

  useEffect(() => {
    if (phase.kind !== "done") return;
    const remaining =
      DONE_PHASE_WINDOW_MS - (Date.now() - (phase.payload.publishedAt ?? 0));
    if (remaining <= 0) {
      setNowTick(Date.now());
      return;
    }
    const timer = setTimeout(() => setNowTick(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [phase, setNowTick]);

  // Hydrate metadata for installed add-ons that aren't in the user's
  // owned `packages` list. Without this, `buildLinearRows` falls back
  // to the raw packageId for the title and `hasUpdate` stays false
  // (because `latestReleaseNumber` is unknown), which disables the
  // update affordance for installed-from-other-creators add-ons.
  const ownedPackageIds = useMemo(
    () => new Set(packages.map((pkg) => pkg.packageId)),
    [packages],
  );
  const installedNeedingPublicLookup = useMemo(() => {
    const ids = new Set<string>();
    for (const mod of installedMods) {
      if (mod.state !== "installed") continue;
      if (!ownedPackageIds.has(mod.packageId)) ids.add(mod.packageId);
    }
    return Array.from(ids);
  }, [installedMods, ownedPackageIds]);
  const publicInstalledPackages = useQuery(
    api.data.store_packages.getPublicPackagesByIds,
    installedNeedingPublicLookup.length > 0
      ? { packageIds: installedNeedingPublicLookup }
      : "skip",
  ) as StorePackageRecord[] | undefined;

  // Merged package list passed to `buildLinearRows`: owned add-ons take
  // precedence over public lookups (an owned record always has the
  // freshest data for the current user).
  const mergedPackages = useMemo(() => {
    if (!publicInstalledPackages || publicInstalledPackages.length === 0) {
      return packages;
    }
    const merged = [...packages];
    for (const pkg of publicInstalledPackages) {
      if (!ownedPackageIds.has(pkg.packageId)) merged.push(pkg);
    }
    return merged;
  }, [packages, publicInstalledPackages, ownedPackageIds]);

  const rows = useMemo(
    () =>
      buildLinearRows({
        features: roster?.features ?? [],
        packages: mergedPackages,
        ownedPackageIds,
        installedMods,
      }),
    [roster, mergedPackages, ownedPackageIds, installedMods],
  );

  const isLocked = phase.kind === "working" || phase.kind === "pick";

  // Compute the catalog payload for `sendMessage`. The agent reads it
  // from the user message context, so we always send the latest local
  // catalog (subjects, files, etc.) — same shape the publish flow had
  // when there was a chat surface.
  const buildCatalog = useCallback(
    (): StoreThreadCommitCatalogEntry[] => {
      const installFootprintHashes = new Set<string>();
      // Build catalog from the runtime's local commit list (cached on
      // the side panel store after roster fetches).
      // For simplicity, re-derive from feature roster fingerprint files
      // is impossible (we'd lose hashes); instead always re-pull the
      // commit list at submit time.
      void installFootprintHashes;
      return []; // backfilled below by the submit handlers
    },
    [],
  );
  void buildCatalog;

  // Shape a `LocalGitCommitRecord[]` as the agent's catalog payload.
  // Trailers are stripped from `body` server-side, so `featureId` /
  // `parentPackageIds` come through as first-class fields on the record.
  const toCatalog = useCallback(
    (
      commits: Array<{
        commitHash: string;
        shortHash: string;
        subject: string;
        body: string;
        timestampMs: number;
        files: string[];
        fileCount: number;
        featureId?: string;
        parentPackageIds?: string[];
      }>,
    ): StoreThreadCommitCatalogEntry[] =>
      commits.map((commit) => ({
        commitHash: commit.commitHash,
        shortHash: commit.shortHash,
        subject: commit.subject,
        body: commit.body,
        timestampMs: commit.timestampMs,
        files: commit.files,
        fileCount: commit.fileCount,
        ...(commit.featureId ? { featureId: commit.featureId } : {}),
        ...(commit.parentPackageIds && commit.parentPackageIds.length > 0
          ? { parentPackageIds: commit.parentPackageIds }
          : {}),
      })),
    [],
  );

  /**
   * Targeted commit catalog for a specific selection. Walks the wide
   * self-mod history (matches the roster window) so feature rows that
   * are still rendered but whose commits fell out of the recent slice
   * still resolve to publishable commits.
   */
  const fetchCatalogForSelection = useCallback(
    async (selector: {
      featureIds?: string[];
      commitHashes?: string[];
    }): Promise<StoreThreadCommitCatalogEntry[]> => {
      const api = window.electronAPI?.store;
      if (!api?.listLocalCommitsBySelector) return [];
      const commits = await api.listLocalCommitsBySelector(selector);
      return toCatalog(commits);
    },
    [toCatalog],
  );

  // ---------------- Action button (Publish / Update) ----------------
  const selectedFeatureRows = rows.filter(
    (row): row is FeatureRow =>
      row.kind === "feature" && selectedFeatureIds.has(row.featureId),
  );
  const selectedUpdateRows = rows.filter(
    (row): row is InstalledRow =>
      row.kind === "installed"
      && row.hasUpdate
      && selectedInstalledPackageIds.has(row.packageId),
  );
  const buttonLabel = (() => {
    if (selectedFeatureRows.length > 0 && selectedUpdateRows.length === 0) {
      return "Publish";
    }
    if (selectedUpdateRows.length > 0 && selectedFeatureRows.length === 0) {
      return "Update";
    }
    return null; // mixed selection or no actionable rows
  })();
  const totalSelected =
    selectedFeatureRows.length + selectedUpdateRows.length;
  const buttonDisabled = !buttonLabel || totalSelected === 0 || isLocked;

  const handleAction = useCallback(async () => {
    if (!buttonLabel) return;

    if (buttonLabel === "Publish") {
      // Resolve commits via the targeted IPC so we hit the same wide
      // history window the feature roster scans (selecting an older
      // feature row used to fail because we only fetched the latest
      // 120 commits and filtered client-side).
      const featureIds = selectedFeatureRows.map((r) => r.featureId);
      const catalog = await fetchCatalogForSelection({ featureIds });
      const hashes = catalog
        .filter(
          (entry) => entry.featureId && featureIds.includes(entry.featureId),
        )
        .map((entry) => entry.commitHash);
      if (hashes.length === 0) {
        showToast({
          title: "Couldn't find recent changes for that selection.",
          variant: "error",
        });
        return;
      }
      const titleList = selectedFeatureRows.map((r) => r.title).join(", ");
      try {
        await sendMessage({
          text: `Publish: ${titleList}`,
          attachedCommitHashes: hashes,
          commitCatalog: catalog,
        });
        storeSidePanelStore.clearSelections();
      } catch (error) {
        showToast({
          title:
            error instanceof Error
              ? error.message
              : "Couldn't start the publish.",
          variant: "error",
        });
      }
      return;
    }

    // Update path: install the latest release for each picked installed
    // add-on directly. No agent involved.
    const electronStore = window.electronAPI?.store;
    if (!electronStore?.installRelease) return;
    let okCount = 0;
    for (const row of selectedUpdateRows) {
      try {
        await electronStore.installRelease({
          packageId: row.packageId,
          releaseNumber: row.latestReleaseNumber,
        });
        okCount += 1;
      } catch (error) {
        showToast({
          title:
            error instanceof Error
              ? error.message
              : `Couldn't update ${row.title}.`,
          variant: "error",
        });
      }
    }
    if (okCount > 0) {
      showToast({
        title:
          okCount === 1
            ? "Updated 1 add-on."
            : `Updated ${okCount} add-ons.`,
        variant: "success",
      });
      storeSidePanelStore.clearSelections();
      // Refresh installed list so badges flip out of "update available".
      try {
        const fresh = await electronStore.listInstalledMods();
        storeSidePanelStore.setInstalledMods(fresh);
      } catch {
        // ignore
      }
    }
  }, [
    buttonLabel,
    fetchCatalogForSelection,
    selectedFeatureRows,
    selectedUpdateRows,
    sendMessage,
  ]);

  // ---------------- Pick / Draft handlers ----------------
  const handleSubmitPick = useCallback(
    async (
      candidatesMessageId: string,
      picked: string[],
    ): Promise<void> => {
      if (picked.length === 0) return;
      // Resolve metadata for *exactly* the picked hashes so the agent's
      // follow-up turn sees subjects/files for what the user chose,
      // regardless of how old those commits are.
      const catalog = await fetchCatalogForSelection({ commitHashes: picked });
      try {
        await submitCandidatesPick({
          candidatesMessageId:
            candidatesMessageId as never /* runtime id pass-through */,
          pickedCommitHashes: picked,
          commitCatalog: catalog,
        });
      } catch (error) {
        showToast({
          title:
            error instanceof Error
              ? error.message
              : "Couldn't submit your pick.",
          variant: "error",
        });
      }
    },
    [fetchCatalogForSelection, submitCandidatesPick],
  );

  const handleConfirmDraft = useCallback(
    async (draftMessageId: string, draft: DraftPayload): Promise<void> => {
      const electronStore = window.electronAPI?.store;
      if (!electronStore?.buildBundleForConfirm) return;
      try {
        const bundle = await electronStore.buildBundleForConfirm({
          commitHashes: draft.commitHashes,
        });
        const result = await confirmDraft({
          draftMessageId: draftMessageId as never,
          commits: bundle.commits,
          files: bundle.files,
          ...(bundle.stellaCommit ? { stellaCommit: bundle.stellaCommit } : {}),
          ...(bundle.installedParents && bundle.installedParents.length > 0
            ? { installedParents: bundle.installedParents }
            : {}),
        });
        showToast({
          title: `Published ${draft.displayName} v${result.releaseNumber}.`,
          variant: "success",
        });
        await refreshFeatureRoster();
      } catch (error) {
        showToast({
          title:
            error instanceof Error
              ? error.message
              : "Couldn't publish this right now.",
          variant: "error",
        });
      }
    },
    [confirmDraft],
  );

  const handleCancelDraft = useCallback(
    async (draftMessageId: string): Promise<void> => {
      try {
        await cancelDraft({ draftMessageId: draftMessageId as never });
      } catch (error) {
        showToast({
          title:
            error instanceof Error ? error.message : "Couldn't cancel draft.",
          variant: "error",
        });
      }
    },
    [cancelDraft],
  );

  // ---------------- Render ----------------
  return (
    <div
      className="display-sidebar__rich display-sidebar__rich--store store-side-panel"
      data-display-tab="store"
    >
      <div className="store-side-panel-header">
        <span>Add-ons</span>
        <button
          type="button"
          className="store-side-panel-refresh"
          onClick={() => void refreshFeatureRoster()}
          aria-label="Refresh"
          disabled={rosterLoading}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {rosterLoading && rows.length === 0 ? (
        <div className="store-side-panel-empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="store-side-panel-empty">
          When Stella modifies itself, your changes show up here. Install
          add-ons from Discover to see them here too.
        </div>
      ) : (
        <div className="store-side-panel-list">
          {rows.map((row) => {
            const selected =
              row.kind === "feature"
                ? selectedFeatureIds.has(row.featureId)
                : selectedInstalledPackageIds.has(row.packageId);
            return (
              <LinearRowItem
                key={row.key}
                row={row}
                selected={selected}
                disabled={isLocked || (row.kind === "installed" && !row.hasUpdate)}
                onToggle={() => {
                  if (row.kind === "feature") {
                    storeSidePanelStore.toggleFeature(row.featureId);
                  } else {
                    storeSidePanelStore.toggleInstalled(row.packageId);
                  }
                }}
              />
            );
          })}
        </div>
      )}

      {/* State machine bottom area */}
      {phase.kind === "working" ? (
        <WorkingCard />
      ) : phase.kind === "pick" ? (
        <PickCard
          payload={phase.payload}
          busy={false}
          onSubmit={(picked) => handleSubmitPick(phase.messageId, picked)}
        />
      ) : phase.kind === "draft" ? (
        <DraftCard
          payload={phase.payload}
          busy={false}
          onConfirm={() => void handleConfirmDraft(phase.messageId, phase.payload)}
          onCancel={() => void handleCancelDraft(phase.messageId)}
        />
      ) : phase.kind === "done" ? (
        <DoneCard payload={phase.payload} />
      ) : totalSelected > 0 && buttonLabel ? (
        <div className="store-side-panel-action">
          <Button
            type="button"
            variant="primary"
            className="pill-btn pill-btn--primary pill-btn--lg"
            onClick={() => void handleAction()}
            disabled={buttonDisabled}
          >
            {buttonLabel} {totalSelected} selected
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny helpers (kept inline so this file is self-contained)
// ---------------------------------------------------------------------------

import { useState as useReactState } from "react";

function useStateMap<K, V>(
  init: () => Map<K, V>,
): [Map<K, V>, (next: Map<K, V>) => void] {
  const [value, setValue] = useReactState<Map<K, V>>(init);
  return [value, setValue];
}

