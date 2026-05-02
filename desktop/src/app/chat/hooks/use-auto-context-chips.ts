/**
 * Auto-detected context chip strip for the panel chat composer.
 *
 * Maintains LANE_COUNT stable lanes. The order doesn't churn just because
 * the underlying recent-apps list rotates — a lane only changes when its
 * pinned content actually disappears (app quit) or a brand-new candidate
 * appears that's not in any lane.
 *
 * Each lane holds up to two occupants — `current` (the chip the user sees,
 * either entering or stable) and `outgoing` (a previous occupant fading out).
 * Rendering both at the same grid position lets us *crossfade* a lane from
 * one chip to another without ever showing an empty strip — there is no
 * "brand-new wipes the row" path anymore.
 *
 * Sources:
 *   - `electronAPI.home.listRecentApps` → list of recent app windows + titles.
 *   - `electronAPI.home.getActiveBrowserTab` → active tab in the frontmost
 *     known browser (URL + title).
 *
 * The strip refreshes every `POLL_INTERVAL_MS`; identity comparisons happen
 * inside the reducer so the visible state only flips when the *content* of
 * a lane actually changes (pid, URL, or window title). The list is
 * intentionally NOT push-driven — polling is cheap and the dedup keeps
 * render churn low.
 */

import { useCallback, useEffect, useReducer, useRef } from "react"
import { getElectronApi } from "@/platform/electron/electron"
import type { ChatContext } from "@/shared/types/electron"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecentAppChip = {
  kind: "app"
  pid: number
  name: string
  bundleId?: string
  isActive: boolean
  /** Topmost on-screen window title for this app, when available. */
  windowTitle?: string
  /** Base64 PNG data URL for the app's icon (macOS); undefined elsewhere. */
  iconDataUrl?: string
}

export type BrowserTabChip = {
  kind: "tab"
  /** Browser display name (e.g. "Brave"). */
  browser: string
  bundleId: string
  url: string
  title?: string
  /** Hostname for compact label rendering ("github.com"). */
  host: string
  /** Browser app's icon, when known (resolved from the recent-apps snapshot). */
  iconDataUrl?: string
}

export type SuggestionChip = RecentAppChip | BrowserTabChip

/** A lane occupant's lifecycle state — drives the entering/leaving CSS transitions. */
type SlotPhase = "stable" | "entering" | "leaving"

/** A single chip occupant rendered inside a lane. */
export type SuggestionSlot = {
  /** Stable React key — preserves identity across re-renders. */
  key: string
  chip: SuggestionChip
  phase: SlotPhase
}

/**
 * A lane is one fixed position in the strip. It can render up to two chips
 * simultaneously: the `current` occupant (entering/stable) and an `outgoing`
 * occupant (leaving). Both are stacked in the same grid cell so swapping a
 * chip looks like a smooth crossfade rather than a pop-out / pop-in.
 */
export type SuggestionLane = {
  current: SuggestionSlot | null
  outgoing: SuggestionSlot | null
}

const LANE_COUNT = 3
const POLL_INTERVAL_MS = 5_000
const FADE_OUT_MS = 220

// Identity key — two chips with the same key are considered "the same
// suggestion" for content-refresh purposes. Tab key folds in URL because
// "github.com" navigating to "google.com" is a real change. App key folds
// in window title for the same reason (user switching Cursor windows).
const chipIdentity = (chip: SuggestionChip): string => {
  if (chip.kind === "tab") return `tab:${chip.bundleId}:${chip.url}`
  return `app:${chip.pid}:${chip.windowTitle ?? ""}`
}

// Looser identity used to detect "this is the same underlying thing,
// just a property changed" — used so a lane stays anchored across small
// title/URL fluctuations. Today this is just the bundle/pid; we still
// detect "real" content changes via chipIdentity but a chip whose
// looseId still matches a live candidate doesn't disappear in a fade-out,
// it gets updated in place.
const chipLooseId = (chip: SuggestionChip): string => {
  if (chip.kind === "tab") return `tab:${chip.bundleId}`
  return `app:${chip.pid}`
}

// ---------------------------------------------------------------------------
// Lane reducer
//
// Given the previous lanes and a fresh ordered list of live candidates, decide
// which chips stay, which start fading out, and which fade in. Rules:
//   1. We pick the top LANE_COUNT loose ids from the candidate list as the
//      *desired* set. Anything below that rank doesn't get a lane — even
//      if it's still alive in the recent-apps list.
//   2. A lane whose current chip's looseId is in the desired set keeps
//      its current — content is updated in place (so isActive/title
//      transitions stay smooth) but the phase doesn't flip. Lanes do NOT
//      reshuffle just because the candidate ordering changed; we anchor
//      each chip to its existing lane for visual stability.
//   3. A lane whose current chip's looseId is NOT in the desired set
//      moves the current → outgoing as `leaving`. This is what handles
//      "a brand-new app pushed an old one out of the top 3": the old
//      chip starts fading out *and* the new chip fills the same lane as
//      `entering` in the same reducer pass, so the two crossfade in place.
//   4. Empty current slots are filled, in candidate priority order, from
//      desired chips that aren't already pinned. Two-phase advance flips
//      `entering` → `stable` on the next frame so CSS can transition.
//
// Critically there is no "bulk wipe the row when something brand new
// appears" path. Every change is per-lane and overlapped, so the row
// is never visually empty mid-swap.
// ---------------------------------------------------------------------------

type LanesState = {
  lanes: SuggestionLane[]
  /** Loose ids of every candidate seen in the last reconcile pass. */
  knownCandidateLooseIds: Set<string>
}

const emptyLane = (): SuggestionLane => ({ current: null, outgoing: null })

const emptyLanes = (): LanesState => ({
  lanes: Array.from({ length: LANE_COUNT }, emptyLane),
  knownCandidateLooseIds: new Set(),
})

const reconcileLanes = (
  prev: LanesState,
  candidates: SuggestionChip[],
): LanesState => {
  const candidatesByLoose = new Map<string, SuggestionChip>()
  const candidateLooseIdsInOrder: string[] = []
  for (const chip of candidates) {
    const loose = chipLooseId(chip)
    if (candidatesByLoose.has(loose)) continue
    candidatesByLoose.set(loose, chip)
    candidateLooseIdsInOrder.push(loose)
  }

  // Bootstrap = first reconcile pass after mount. Fill lanes as `stable`
  // (no fade-in) so the strip doesn't blink in on first render.
  const isBootstrap = prev.knownCandidateLooseIds.size === 0

  // The desired set = the top LANE_COUNT candidates by priority. Anything
  // beyond that doesn't get a lane, even if it's still in the recent-apps
  // list. This is what makes a brand-new top candidate *displace* an
  // existing chip rather than silently sit in the polling result.
  const desiredLooseIds = candidateLooseIdsInOrder.slice(0, LANE_COUNT)
  const desiredSet = new Set(desiredLooseIds)

  // Pass 1: keep lanes whose current chip is in the desired top-N; move
  // currents that fell out of the desired set into `outgoing` (leaving)
  // so they can fade out *while* their replacement fades in.
  const stagedLanes: SuggestionLane[] = prev.lanes.map((lane) => {
    const current = lane.current
    if (!current) return { current: null, outgoing: lane.outgoing }

    const looseId = chipLooseId(current.chip)
    if (desiredSet.has(looseId)) {
      const liveMatch = candidatesByLoose.get(looseId)!
      const sameContent =
        chipIdentity(liveMatch) === chipIdentity(current.chip) &&
        sameSurfaceFields(liveMatch, current.chip)
      const refreshed: SuggestionSlot = sameContent
        ? current.phase === "stable"
          ? current
          : { ...current, phase: "stable" }
        : { key: current.key, chip: liveMatch, phase: "stable" }
      return { current: refreshed, outgoing: lane.outgoing }
    }

    // Current chip is no longer in the desired top-N (either dropped out
    // of candidates entirely, or got demoted by a higher-priority new
    // arrival). If outgoing is already occupied the in-flight fade is
    // overwritten — acceptable because both chips are leaving the same
    // lane anyway.
    return {
      current: null,
      outgoing: { ...current, phase: "leaving" },
    }
  })

  // Pass 2: which loose ids are now claimed by a current?
  const occupied = new Set<string>()
  for (const lane of stagedLanes) {
    if (lane.current) occupied.add(chipLooseId(lane.current.chip))
  }

  // Pass 3: fill empty lanes with desired candidates not yet pinned, in
  // priority order. These are typically (a) chips that just appeared at
  // the top and bumped a lower-ranked chip out, or (b) chips filling a
  // freshly-vacated lane (e.g. an app quit).
  const remaining = desiredLooseIds.filter((loose) => !occupied.has(loose))
  let r = 0
  const finalLanes: SuggestionLane[] = stagedLanes.map((lane) => {
    if (lane.current) return lane
    if (r >= remaining.length) return lane
    const chip = candidatesByLoose.get(remaining[r++])
    if (!chip) return lane
    return {
      current: {
        key: makeSlotKey(chip),
        chip,
        phase: isBootstrap ? "stable" : "entering",
      },
      outgoing: lane.outgoing,
    }
  })

  if (
    lanesEqual(prev.lanes, finalLanes) &&
    setsEqual(prev.knownCandidateLooseIds, new Set(candidateLooseIdsInOrder))
  ) {
    return prev
  }

  return {
    lanes: finalLanes,
    knownCandidateLooseIds: new Set(candidateLooseIdsInOrder),
  }
}

const sameSurfaceFields = (a: SuggestionChip, b: SuggestionChip): boolean => {
  if (a.kind !== b.kind) return false
  if (a.kind === "tab" && b.kind === "tab") {
    return a.host === b.host && a.title === b.title && a.browser === b.browser
  }
  if (a.kind === "app" && b.kind === "app") {
    return a.name === b.name && a.isActive === b.isActive
  }
  return false
}

const makeSlotKey = (chip: SuggestionChip): string => {
  if (chip.kind === "tab") return `slot-tab-${chip.bundleId}-${Date.now()}`
  return `slot-app-${chip.pid}-${Date.now()}`
}

type LanesAction =
  | { type: "reconcile"; candidates: SuggestionChip[] }
  | { type: "advancePhase"; slotKey: string; phase: SlotPhase }
  | { type: "dropOutgoing"; slotKey: string }
  | { type: "clearChip"; slotKey: string }

const lanesReducer = (state: LanesState, action: LanesAction): LanesState => {
  switch (action.type) {
    case "reconcile":
      return reconcileLanes(state, action.candidates)
    case "advancePhase": {
      let changed = false
      const next = state.lanes.map((lane) => {
        if (lane.current && lane.current.key === action.slotKey) {
          if (lane.current.phase === action.phase) return lane
          changed = true
          return {
            ...lane,
            current: { ...lane.current, phase: action.phase },
          }
        }
        return lane
      })
      if (!changed) return state
      return { ...state, lanes: next }
    }
    case "dropOutgoing": {
      let changed = false
      const next = state.lanes.map((lane) => {
        if (lane.outgoing && lane.outgoing.key === action.slotKey) {
          changed = true
          return { ...lane, outgoing: null }
        }
        return lane
      })
      if (!changed) return state
      return { ...state, lanes: next }
    }
    case "clearChip": {
      let changed = false
      const next = state.lanes.map((lane) => {
        if (lane.current && lane.current.key === action.slotKey) {
          changed = true
          return {
            current: null,
            outgoing: { ...lane.current, phase: "leaving" as const },
          }
        }
        return lane
      })
      if (!changed) return state
      return { ...state, lanes: next }
    }
    default:
      return state
  }
}

const lanesEqual = (a: SuggestionLane[], b: SuggestionLane[]): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].current !== b[i].current) return false
    if (a[i].outgoing !== b[i].outgoing) return false
  }
  return true
}

const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

// ---------------------------------------------------------------------------
// Sources — talk to the electron home API and emit normalized chips. Polling
// is a thin wrapper; the reducer above is what keeps the visible strip stable.
// ---------------------------------------------------------------------------

type FetchSnapshotResult = {
  apps: RecentAppChip[]
  tab: BrowserTabChip | null
}

const fetchSnapshot = async (): Promise<FetchSnapshotResult> => {
  const api = getElectronApi()
  if (!api?.home?.listRecentApps) return { apps: [], tab: null }

  let apps: RecentAppChip[] = []
  try {
    const result = await api.home.listRecentApps(8)
    apps = (result?.apps ?? []).map<RecentAppChip>((app) => ({
      kind: "app",
      pid: app.pid,
      name: app.name,
      bundleId: app.bundleId,
      isActive: app.isActive,
      windowTitle: app.windowTitle,
      iconDataUrl: app.iconDataUrl,
    }))
  } catch {
    apps = []
  }

  let tab: BrowserTabChip | null = null
  const activeBrowser = apps.find((app) => app.isActive && app.bundleId)
  if (activeBrowser?.bundleId && api.home.getActiveBrowserTab) {
    try {
      const result = await api.home.getActiveBrowserTab(activeBrowser.bundleId)
      const next = result?.tab ?? null
      if (next) {
        let host = ""
        try {
          host = new URL(next.url).hostname.replace(/^www\./, "")
        } catch {
          host = next.url
        }
        const tabBundleId = next.bundleId ?? activeBrowser.bundleId
        // Reuse the icon from the matching app in the snapshot when we have
        // it — the active browser is always present in `apps`, so a second
        // round-trip just for an icon would be wasteful.
        const browserIcon = apps.find(
          (app) => app.bundleId === tabBundleId,
        )?.iconDataUrl
        tab = {
          kind: "tab",
          browser: next.browser,
          bundleId: tabBundleId,
          url: next.url,
          title: next.title,
          host,
          iconDataUrl: browserIcon,
        }
      }
    } catch {
      tab = null
    }
  }

  return { apps, tab }
}

// Suggestion priority for filling lanes: browser tab first (when present),
// then the frontmost app, then the rest in recency order. The same browser
// app gets dropped from the app list so we don't duplicate the browser tab.
// We don't re-sort by `isActive` — focus changes shouldn't shuffle the strip.
const orderCandidates = ({ apps, tab }: FetchSnapshotResult): SuggestionChip[] => {
  const out: SuggestionChip[] = []
  if (tab) out.push(tab)
  const seenPids = new Set<number>()
  for (const app of apps) {
    if (seenPids.has(app.pid)) continue
    seenPids.add(app.pid)
    if (tab && app.bundleId === tab.bundleId) continue
    out.push(app)
  }
  return out
}

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

type AutoContextChipsApi = {
  lanes: SuggestionLane[]
  /** Mark the lane occupant with this slot key as leaving (fade-out). */
  dismissSlot: (slotKey: string) => void
}

export function useAutoContextChips(
  active: boolean = true,
): AutoContextChipsApi {
  const [state, dispatch] = useReducer(lanesReducer, undefined, emptyLanes)

  // Polling — kept simple. The reducer absorbs identical payloads; the
  // visible state only changes when a lane actually shifts.
  const cancelledRef = useRef(false)
  useEffect(() => {
    cancelledRef.current = false
    if (!active) {
      cancelledRef.current = true
      return
    }

    const api = getElectronApi()
    if (!api?.home?.listRecentApps) return

    let interval: number | null = null

    const refresh = async () => {
      const snapshot = await fetchSnapshot()
      if (cancelledRef.current) return
      const candidates = orderCandidates(snapshot)
      dispatch({ type: "reconcile", candidates })
    }

    void refresh()
    interval = window.setInterval(refresh, POLL_INTERVAL_MS)

    return () => {
      cancelledRef.current = true
      if (interval) window.clearInterval(interval)
    }
  }, [active])

  // Drive entering→stable on the next frame so CSS can transition.
  useEffect(() => {
    const enteringSlots: SuggestionSlot[] = []
    for (const lane of state.lanes) {
      if (lane.current?.phase === "entering") enteringSlots.push(lane.current)
    }
    if (enteringSlots.length === 0) return undefined

    const raf = window.requestAnimationFrame(() => {
      for (const slot of enteringSlots) {
        dispatch({ type: "advancePhase", slotKey: slot.key, phase: "stable" })
      }
    })
    return () => window.cancelAnimationFrame(raf)
  }, [state.lanes])

  // Drop outgoing chips after their fade-out timer.
  useEffect(() => {
    const outgoingSlots: SuggestionSlot[] = []
    for (const lane of state.lanes) {
      if (lane.outgoing) outgoingSlots.push(lane.outgoing)
    }
    if (outgoingSlots.length === 0) return undefined

    const timers = outgoingSlots.map((slot) =>
      window.setTimeout(() => {
        dispatch({ type: "dropOutgoing", slotKey: slot.key })
      }, FADE_OUT_MS),
    )
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [state.lanes])

  const dismissSlot = useCallback((slotKey: string) => {
    dispatch({ type: "clearChip", slotKey })
  }, [])

  return {
    lanes: state.lanes,
    dismissSlot,
  }
}

// ---------------------------------------------------------------------------
// Adapters: turn a chip into a ChatContext for the composer
// ---------------------------------------------------------------------------

export function appChipToChatContext(app: RecentAppChip): ChatContext {
  return {
    window: {
      title: app.windowTitle ?? "",
      app: app.name,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    },
    browserUrl: null,
    selectedText: null,
    regionScreenshots: [],
    windowScreenshot: null,
    capturePending: true,
  }
}

export function tabChipToChatContext(tab: BrowserTabChip): ChatContext {
  return {
    window: {
      title: tab.title ?? "",
      app: tab.browser,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    },
    browserUrl: tab.url,
    selectedText: null,
    regionScreenshots: [],
    windowScreenshot: null,
    capturePending: true,
  }
}
