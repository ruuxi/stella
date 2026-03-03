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

  constructor(private readonly electronDir: string) {}

  private getPagesDir() {
    return path.resolve(this.electronDir, '..', 'src', 'views', 'home', 'pages')
  }

  async listWorkspacePanels(): Promise<WorkspacePanel[]> {
    const pagesDir = this.getPagesDir()

    let entries: Dirent[]
    try {
      entries = await fs.readdir(pagesDir, { withFileTypes: true, encoding: 'utf8' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[workspace:listPanels] Failed to read pages directory', error)
      }
      return []
    }

    const candidates = entries.filter(
      (entry) => entry.isFile() && WORKSPACE_PANEL_FILE_PATTERN.test(entry.name),
    )

    const withMeta = await Promise.all(
      candidates.map(async (entry) => {
        const fullPath = path.join(pagesDir, entry.name)
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
    const pagesDir = this.getPagesDir()

    try {
      if (!fsSync.existsSync(pagesDir)) {
        fsSync.mkdirSync(pagesDir, { recursive: true })
      }
    } catch (err) {
      console.debug('[workspace] Failed to create pages directory:', err)
    }

    try {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      this.panelWatcher = fsSync.watch(pagesDir, { persistent: false }, () => {
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
