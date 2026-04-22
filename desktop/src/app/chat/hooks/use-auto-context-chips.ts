/**
 * Auto-detected context chip strip for the chat sidebar composer.
 *
 * Maintains 3 stable suggestion slots. The order doesn't churn just because
 * the underlying recent-apps list rotates — slots only change when their
 * pinned content actually disappears (app quit) or a brand-new candidate
 * appears that's not in any slot. This keeps the strip readable instead of
 * shuffling on every focus change.
 *
 * Sources:
 *   - `electronAPI.home.listRecentApps` → list of recent app windows + titles.
 *   - `electronAPI.home.getActiveBrowserTab` → active tab in the frontmost
 *     known browser (URL + title).
 *
 * The strip refreshes every `POLL_INTERVAL_MS`; identity comparisons happen
 * inside the reducer so the visible state only flips when the *content* of
 * a slot changes (pid, URL, or window title). The list is intentionally
 * NOT push-driven — polling is cheap and the dedup keeps render churn low.
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

/** A slot's lifecycle state — drives the entering/leaving CSS transitions. */
export type SlotPhase = "stable" | "entering" | "leaving"

export type SuggestionSlot = {
  /** Stable React key — preserves identity across re-renders inside one slot. */
  key: string
  chip: SuggestionChip
  phase: SlotPhase
}

const SLOT_COUNT = 3
const POLL_INTERVAL_MS = 5_000
const FADE_OUT_MS = 220

// Identity key — two chips with the same key are considered "the same
// suggestion" for slot-replacement purposes. Tab key folds in URL because
// "github.com" navigating to "google.com" is a real change. App key folds
// in window title for the same reason (user switching Cursor windows).
const chipIdentity = (chip: SuggestionChip): string => {
  if (chip.kind === "tab") return `tab:${chip.bundleId}:${chip.url}`
  return `app:${chip.pid}:${chip.windowTitle ?? ""}`
}

// Looser identity used to detect "this is the same underlying thing,
// just a property changed" — used so the slot stays anchored across small
// title/URL fluctuations. Today this is just the bundle/pid; we still
// detect "real" changes via chipIdentity but a slot whose looseId still
// matches a live candidate doesn't disappear in a fade-out, it gets
// updated in place.
const chipLooseId = (chip: SuggestionChip): string => {
  if (chip.kind === "tab") return `tab:${chip.bundleId}`
  return `app:${chip.pid}`
}

// ---------------------------------------------------------------------------
// Slot reducer
//
// Given the previous slots and a fresh ordered list of live candidates, decide
// which slots stay, which fade out, and which fade in. Rules:
//   1. A slot whose chip's looseId matches a live candidate stays — its
//      contents are updated to the live candidate (so isActive/title
//      transitions stay smooth) but the slot does not flip phase.
//   2. A slot whose chip's looseId is no longer in the live list flips to
//      `leaving`. After FADE_OUT_MS it's removed; the next reducer pass can
//      fill it.
//   3. Empty (or post-leaving) slots accept the next live candidate that
//      isn't already pinned, set to `entering`. The component clears
//      `entering` to `stable` after a frame so CSS can transition.
// ---------------------------------------------------------------------------

type SlotsState = {
  slots: (SuggestionSlot | null)[]
  /** Loose ids of chips currently held by a live (stable/entering) slot. */
  pinnedLooseIds: Set<string>
  /**
   * Loose ids of every candidate seen in the last reconcile pass. Used to
   * detect "brand-new" candidates (apps that just launched, tabs that just
   * opened) so we can fade-replace the whole strip instead of waiting for
   * an existing slot to empty.
   */
  knownCandidateLooseIds: Set<string>
}

const emptySlots = (): SlotsState => ({
  slots: new Array(SLOT_COUNT).fill(null),
  pinnedLooseIds: new Set(),
  knownCandidateLooseIds: new Set(),
})

const reconcileSlots = (
  prev: SlotsState,
  candidates: SuggestionChip[],
): SlotsState => {
  const candidatesByLoose = new Map<string, SuggestionChip>()
  const candidateLooseIdsInOrder: string[] = []
  for (const chip of candidates) {
    const loose = chipLooseId(chip)
    if (candidatesByLoose.has(loose)) continue
    candidatesByLoose.set(loose, chip)
    candidateLooseIdsInOrder.push(loose)
  }

  // "Brand new" = a candidate's loose id wasn't in the previous candidate
  // set AND isn't currently pinned in a slot. The first reconcile pass
  // (when prev.knownCandidateLooseIds is empty) is treated as bootstrap;
  // we don't fade-replace there because there's nothing to replace.
  const isBootstrap = prev.knownCandidateLooseIds.size === 0
  const currentPinnedLoose = new Set<string>()
  for (const slot of prev.slots) {
    if (slot && slot.phase !== "leaving") {
      currentPinnedLoose.add(chipLooseId(slot.chip))
    }
  }
  const hasBrandNew =
    !isBootstrap &&
    candidateLooseIdsInOrder.some(
      (loose) =>
        !prev.knownCandidateLooseIds.has(loose) &&
        !currentPinnedLoose.has(loose),
    )

  const nextKnown = new Set(candidateLooseIdsInOrder)

  // Brand-new candidate while the strip is full → fade out the entire
  // current strip in one coordinated batch. The next reconcile pass (after
  // the leaving slots drain) will fill the empty slots with the freshest
  // candidates from the live list.
  if (hasBrandNew) {
    const fadingSlots: (SuggestionSlot | null)[] = prev.slots.map((slot) => {
      if (!slot) return null
      if (slot.phase === "leaving") return slot
      return { ...slot, phase: "leaving" as const }
    })
    return {
      slots: fadingSlots,
      pinnedLooseIds: new Set(),
      knownCandidateLooseIds: nextKnown,
    }
  }

  const nextSlots: (SuggestionSlot | null)[] = prev.slots.map((slot) => {
    if (!slot) return null
    if (slot.phase === "leaving") return slot

    const looseId = chipLooseId(slot.chip)
    const liveMatch = candidatesByLoose.get(looseId)
    if (liveMatch) {
      // Update content in place; keep phase + key.
      const sameContent =
        chipIdentity(liveMatch) === chipIdentity(slot.chip) &&
        sameSurfaceFields(liveMatch, slot.chip)
      if (sameContent) {
        return slot.phase === "stable" ? slot : { ...slot, phase: "stable" }
      }
      return {
        key: slot.key,
        chip: liveMatch,
        phase: "stable",
      }
    }

    // Slot's chip is gone from the live list — fade it out.
    return { ...slot, phase: "leaving" }
  })

  const pinnedLoose = new Set<string>()
  for (const slot of nextSlots) {
    if (slot && slot.phase !== "leaving") pinnedLoose.add(chipLooseId(slot.chip))
  }

  // Fill any non-leaving empty slots with new candidates, in order.
  for (
    let slotIndex = 0;
    slotIndex < nextSlots.length;
    slotIndex += 1
  ) {
    const current = nextSlots[slotIndex]
    if (current !== null) continue

    const fillerLooseId = candidateLooseIdsInOrder.find(
      (loose) => !pinnedLoose.has(loose),
    )
    if (!fillerLooseId) break

    const filler = candidatesByLoose.get(fillerLooseId)!
    nextSlots[slotIndex] = {
      key: makeSlotKey(filler),
      chip: filler,
      phase: "entering",
    }
    pinnedLoose.add(fillerLooseId)
  }

  return {
    slots: nextSlots,
    pinnedLooseIds: pinnedLoose,
    knownCandidateLooseIds: nextKnown,
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

type SlotsAction =
  | { type: "reconcile"; candidates: SuggestionChip[] }
  | { type: "advancePhase"; slotKey: string; phase: SlotPhase }
  | { type: "drop"; slotKey: string }
  | { type: "clearChip"; chipKey: string }
  | { type: "pin"; chip: SuggestionChip }

const slotsReducer = (state: SlotsState, action: SlotsAction): SlotsState => {
  switch (action.type) {
    case "reconcile":
      return reconcileSlots(state, action.candidates)
    case "advancePhase": {
      const next = state.slots.map((slot) =>
        slot && slot.key === action.slotKey
          ? { ...slot, phase: action.phase }
          : slot,
      )
      return refreshPinned(state, next)
    }
    case "drop": {
      const next = state.slots.map((slot) =>
        slot && slot.key === action.slotKey ? null : slot,
      )
      return refreshPinned(state, next)
    }
    case "clearChip": {
      const next: (SuggestionSlot | null)[] = state.slots.map((slot) => {
        if (!slot) return null
        if (slot.key !== action.chipKey) return slot
        // Mark as leaving so the next reconcile can fill it. Phase clears
        // to leaving immediately so CSS can run the fade-out.
        return { ...slot, phase: "leaving" as const }
      })
      return refreshPinned(state, next)
    }
    case "pin": {
      const looseId = chipLooseId(action.chip)
      // If this chip's loose id is already in a slot, just refresh its
      // content (no fade — it was already there in some form).
      const updated = state.slots.map((slot) => {
        if (!slot) return null
        if (chipLooseId(slot.chip) !== looseId) return slot
        return { key: slot.key, chip: action.chip, phase: "stable" as const }
      })
      const alreadyPinned = updated.some(
        (slot) => slot && chipLooseId(slot.chip) === looseId,
      )
      if (alreadyPinned) return refreshPinned(state, updated)

      // Otherwise drop into the first empty slot, or evict the last
      // non-active app slot so the user-pinned chip wins. Browser tab
      // chips live in slot 0 by convention; everything else goes after.
      const targetIndex = updated.findIndex((slot) => slot === null)
      if (targetIndex !== -1) {
        updated[targetIndex] = {
          key: makeSlotKey(action.chip),
          chip: action.chip,
          phase: "entering",
        }
        return refreshPinned(state, updated)
      }

      // No empty slot — evict the last slot to make room. The evicted
      // chip's content will be re-fetched on the next reconcile if it's
      // still live, but the pin takes precedence right now.
      updated[updated.length - 1] = {
        key: makeSlotKey(action.chip),
        chip: action.chip,
        phase: "entering",
      }
      return refreshPinned(state, updated)
    }
    default:
      return state
  }
}

const refreshPinned = (
  prev: SlotsState,
  nextSlots: (SuggestionSlot | null)[],
): SlotsState => {
  const pinned = new Set<string>()
  for (const slot of nextSlots) {
    if (slot && slot.phase !== "leaving") pinned.add(chipLooseId(slot.chip))
  }
  if (slotsEqual(prev.slots, nextSlots) && setsEqual(prev.pinnedLooseIds, pinned)) {
    return prev
  }
  return {
    slots: nextSlots,
    pinnedLooseIds: pinned,
    knownCandidateLooseIds: prev.knownCandidateLooseIds,
  }
}

const slotsEqual = (
  a: (SuggestionSlot | null)[],
  b: (SuggestionSlot | null)[],
): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
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

// Suggestion priority for filling slots: browser tab first (when present),
// then the frontmost app, then the rest in recency order. The same browser
// app gets dropped from the app list so we don't duplicate the browser tab.
// Browser tab fills slot 0 when present (it's the most specific signal we
// have). The rest of the apps come in the order the native helper gave us,
// which is most-recent-used (front-to-back z-order). We don't re-sort by
// `isActive` — focus changes shouldn't shuffle the strip.
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

export type AutoContextChipsApi = {
  slots: (SuggestionSlot | null)[]
  /** Mark the slot containing this chip key as leaving (fade-out). */
  dismissSlot: (slotKey: string) => void
  /** Inject an external suggestion (e.g. cmd+rc → Open chat). */
  pinSuggestion: (chip: SuggestionChip) => void
}

export function useAutoContextChips(
  active: boolean = true,
): AutoContextChipsApi {
  const [state, dispatch] = useReducer(slotsReducer, undefined, emptySlots)

  // Polling — kept simple. The reducer absorbs identical payloads; the
  // visible state only changes when slot identity actually shifts.
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

  // Drive entering→stable on the next frame so CSS can transition, and
  // leaving→removed after the fade-out timer.
  useEffect(() => {
    const enteringSlots = state.slots.filter(
      (slot): slot is SuggestionSlot => slot?.phase === "entering",
    )
    if (enteringSlots.length === 0) return undefined

    const raf = window.requestAnimationFrame(() => {
      for (const slot of enteringSlots) {
        dispatch({ type: "advancePhase", slotKey: slot.key, phase: "stable" })
      }
    })
    return () => window.cancelAnimationFrame(raf)
  }, [state.slots])

  useEffect(() => {
    const leavingSlots = state.slots.filter(
      (slot): slot is SuggestionSlot => slot?.phase === "leaving",
    )
    if (leavingSlots.length === 0) return undefined

    const timers = leavingSlots.map((slot) =>
      window.setTimeout(() => {
        dispatch({ type: "drop", slotKey: slot.key })
      }, FADE_OUT_MS),
    )
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [state.slots])

  const dismissSlot = useCallback((slotKey: string) => {
    dispatch({ type: "clearChip", chipKey: slotKey })
  }, [])

  const pinSuggestion = useCallback((chip: SuggestionChip) => {
    dispatch({ type: "pin", chip })
  }, [])

  return {
    slots: state.slots,
    dismissSlot,
    pinSuggestion,
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
