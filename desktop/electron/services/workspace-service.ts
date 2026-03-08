import { promises as fs } from 'fs'
import fsSync from 'fs'
import type { BrowserWindow } from 'electron'
import path from 'path'
import type { Dirent } from 'fs'

const WORKSPACE_PANEL_FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.tsx$/

type WorkspacePanel = {
  name: string
  title: string
}

const formatWorkspacePanelTitle = (name: string) => {
  const withoutPrefix = name.replace(/^pd_/, '')
  const parts = withoutPrefix
    .split(/[_-]+/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length === 0) {
    return name
  }
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export class WorkspaceService {
  private panelWatcher: fsSync.FSWatcher | null = null

  constructor(
    private readonly getStellaHomePath: () => string | null,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  private getPanelsDir() {
    if (!this.isEnabled()) {
      return null
    }

    const stellaHomePath = this.getStellaHomePath()
    if (!stellaHomePath) {
      return null
    }
    return path.join(stellaHomePath, 'workspace', 'panels')
  }

  async listWorkspacePanels(): Promise<WorkspacePanel[]> {
    const panelsDir = this.getPanelsDir()
    if (!panelsDir) {
      return []
    }

    let entries: Dirent[]
    try {
      entries = await fs.readdir(panelsDir, { withFileTypes: true, encoding: 'utf8' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[workspace:listPanels] Failed to read workspace panels directory', error)
      }
      return []
    }

    const candidates = entries.filter(
      (entry) => entry.isFile() && WORKSPACE_PANEL_FILE_PATTERN.test(entry.name),
    )

    const withMeta = await Promise.all(
      candidates.map(async (entry) => {
        const fullPath = path.join(panelsDir, entry.name)
        let mtimeMs = 0
        try {
          const stat = await fs.stat(fullPath)
          mtimeMs = stat.mtimeMs
        } catch {
          // Best effort metadata; stale/deleted files are still listable.
        }

        const name = entry.name.slice(0, -4)
        return {
          name,
          title: formatWorkspacePanelTitle(name),
          mtimeMs,
        }
      }),
    )

    return withMeta
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.title.localeCompare(b.title))
      .map(({ name, title }) => ({ name, title }))
  }

  startWorkspacePanelWatcher(mainWindow: BrowserWindow) {
    this.stopWorkspacePanelWatcher()
    const panelsDir = this.getPanelsDir()
    if (!panelsDir) {
      return
    }

    try {
      if (!fsSync.existsSync(panelsDir)) {
        fsSync.mkdirSync(panelsDir, { recursive: true })
      }
    } catch (err) {
      console.debug('[workspace] Failed to create workspace panels directory:', err)
    }

    try {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      this.panelWatcher = fsSync.watch(panelsDir, { persistent: false }, () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(async () => {
          debounceTimer = null
          try {
            const panels = await this.listWorkspacePanels()
            mainWindow.webContents.send('workspace:panelsChanged', panels)
          } catch (err) {
            console.debug('[workspace] Failed to refresh panels:', err)
          }
        }, 300)
      })
    } catch (error) {
      console.warn('[workspace] Failed to start panel watcher:', error)
    }
  }

  stopWorkspacePanelWatcher() {
    if (this.panelWatcher) {
      this.panelWatcher.close()
      this.panelWatcher = null
    }
  }
}
