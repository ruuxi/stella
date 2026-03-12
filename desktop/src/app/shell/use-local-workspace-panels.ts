import { useEffect, useMemo, useState } from 'react'
import { getElectronApi } from '@/platform/electron/electron'
import { areLocalWorkspacePanelsEnabled } from '@/shared/lib/local-workspace-panels'
import type { PersonalPage } from './HeaderTabBar'

type LocalWorkspacePanel = {
  name: string
  title: string
}

const LOCAL_PANEL_PAGE_PREFIX = 'local_panel:'
const LOCAL_PANELS_POLL_INTERVAL_MS = 3_000
const EMPTY_PERSONAL_PAGES: PersonalPage[] = []

const arePanelListsEqual = (
  left: LocalWorkspacePanel[],
  right: LocalWorkspacePanel[],
) => {
  if (left.length !== right.length) return false

  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index]?.name !== right[index]?.name ||
      left[index]?.title !== right[index]?.title
    ) {
      return false
    }
  }

  return true
}

const normalizePanels = (result: unknown): LocalWorkspacePanel[] =>
  (Array.isArray(result) ? result : [])
    .filter(
      (panel): panel is LocalWorkspacePanel =>
        Boolean(
          panel
            && typeof panel.name === 'string'
            && typeof panel.title === 'string',
        ),
    )
    .map((panel) => ({
      name: panel.name.trim(),
      title: panel.title.trim() || panel.name.trim(),
    }))
    .filter((panel) => panel.name.length > 0)

export function useLocalWorkspacePanels() {
  const isLocalWorkspacePanelsEnabled = areLocalWorkspacePanelsEnabled()
  const [localWorkspacePanels, setLocalWorkspacePanels] = useState<LocalWorkspacePanel[]>(
    [],
  )

  useEffect(() => {
    if (!isLocalWorkspacePanelsEnabled) {
      return
    }

    const electronApi = getElectronApi()
    if (!electronApi?.browser.listWorkspacePanels) {
      return
    }

    let cancelled = false

    const applyPanels = (normalized: LocalWorkspacePanel[]) => {
      if (cancelled) return

      setLocalWorkspacePanels((previous) =>
        arePanelListsEqual(previous, normalized) ? previous : normalized,
      )
    }

    const loadPanels = async () => {
      try {
        const result = await electronApi.browser.listWorkspacePanels()
        if (cancelled) return
        applyPanels(normalizePanels(result))
      } catch (error) {
        console.debug(
          '[useLocalWorkspacePanels] Failed to load workspace panels:',
          (error as Error).message,
        )
      }
    }

    void loadPanels()

    const unsubscribe = electronApi.browser.onWorkspacePanelsChanged?.((panels) => {
      applyPanels(normalizePanels(panels))
    })

    let intervalId: number | undefined
    if (!unsubscribe) {
      intervalId = window.setInterval(() => {
        void loadPanels()
      }, LOCAL_PANELS_POLL_INTERVAL_MS)
    }

    return () => {
      cancelled = true
      unsubscribe?.()
      if (intervalId !== undefined) {
        window.clearInterval(intervalId)
      }
    }
  }, [isLocalWorkspacePanelsEnabled])

  const personalPages = useMemo<PersonalPage[]>(
    () => {
      if (!isLocalWorkspacePanelsEnabled) {
        return EMPTY_PERSONAL_PAGES
      }

      return localWorkspacePanels.map((panel, index) => ({
        pageId: `${LOCAL_PANEL_PAGE_PREFIX}${panel.name}`,
        panelName: panel.name,
        title: panel.title,
        order: index,
      }))
    },
    [isLocalWorkspacePanelsEnabled, localWorkspacePanels],
  )

  return { personalPages }
}
