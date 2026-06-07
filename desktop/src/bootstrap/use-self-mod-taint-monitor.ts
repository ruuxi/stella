import { useEffect, useRef } from 'react'
import { showToast } from '@/ui/toast'

const SELF_MOD_TAINT_CHECK_INTERVAL_MS = 60_000

const buildTaintFingerprint = (
  tainted: {
    featureId: string
    taintedFiles?: string[]
  }[],
) =>
  tainted
    .map(
      (feature) =>
        `${feature.featureId}:${(feature.taintedFiles ?? []).slice().sort().join(',')}`,
    )
    .sort()
    .join('|')

const buildTaintPreview = (
  tainted: {
    name: string
  }[],
) => {
  const previewNames = tainted
    .slice(0, 2)
    .map((feature) => feature.name)
    .join(', ')

  const extraCount = tainted.length > 2 ? tainted.length - 2 : 0
  const extraText = extraCount > 0 ? ` and ${extraCount} more` : ''

  return `${previewNames}${extraText}`
}

export const useSelfModTaintMonitor = () => {
  const lastFingerprintRef = useRef('')

  useEffect(() => {
    const agentApi = window.electronAPI?.agent
    if (!agentApi?.listSelfModFeatures) {
      return
    }

    let cancelled = false

    const checkForTaintedSelfModFeatures = async () => {
      if (cancelled) return

      // Defensive perf guard: this hook is currently unmounted, but if a
      // future mount lands it would otherwise poll IPC every 60s in *every*
      // window. Skip the IPC round-trip when the window is hidden or
      // unfocused — a backgrounded/blurred window has no UI surface to show
      // the toast, so there's nothing to lose by deferring to the next tick.
      if (
        (typeof document !== 'undefined' && document.hidden) ||
        (typeof document !== 'undefined' && document.hasFocus && !document.hasFocus())
      ) {
        return
      }

      try {
        const activeRun = await agentApi.getActiveRun?.()
        if (activeRun) return

        const features = await agentApi.listSelfModFeatures(8)
        if (cancelled || !features) return

        const tainted = features.filter((feature) => feature.tainted)
        if (tainted.length === 0) {
          lastFingerprintRef.current = ''
          return
        }

        const fingerprint = buildTaintFingerprint(tainted)
        if (fingerprint === lastFingerprintRef.current) {
          return
        }

        lastFingerprintRef.current = fingerprint

        showToast({
          title: 'External UI edits detected',
          description: `${buildTaintPreview(tainted)} changed outside Stella. Keep changes to adopt them, or use Undo to discard.`,
          variant: 'loading',
          duration: 4_000,
        })
      } catch {
        // Best effort only.
      }
    }

    void checkForTaintedSelfModFeatures()
    const timer = window.setInterval(() => {
      void checkForTaintedSelfModFeatures()
    }, SELF_MOD_TAINT_CHECK_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])
}
