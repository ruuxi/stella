import { promises as fs } from 'fs'
import { ipcMain } from 'electron'
import os from 'os'
import path from 'path'

type StoreHandlersOptions = Record<string, never>

export const registerStoreHandlers = (_options: StoreHandlersOptions) => {
  ipcMain.handle('theme:listInstalled', async () => {
    const themesDir = path.join(os.homedir(), '.stella', 'themes')
    try {
      const files = await fs.readdir(themesDir)
      const themes = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = await fs.readFile(path.join(themesDir, file), 'utf-8')
          const theme = JSON.parse(raw)
          if (theme.id && theme.name && theme.light && theme.dark) {
            themes.push(theme)
          }
        } catch {
          // skip invalid theme files
        }
      }
      return themes
    } catch {
      return []
    }
  })
}
