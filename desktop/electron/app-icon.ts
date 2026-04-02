import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const resolveProjectRoot = (electronDir: string) => path.resolve(electronDir, '..', '..')

export const resolveAppIconPath = (electronDir: string) => {
  const projectRoot = resolveProjectRoot(electronDir)
  const packagedIconPath = path.join(projectRoot, 'dist', 'stella-app-icon.png')

  if (fs.existsSync(packagedIconPath)) {
    return packagedIconPath
  }

  return path.join(projectRoot, 'public', 'stella-app-icon.png')
}

export const applyDockIcon = (electronDir: string) => {
  if (process.platform !== 'darwin' || !app.dock) {
    return
  }

  const iconPath = resolveAppIconPath(electronDir)
  if (!fs.existsSync(iconPath)) {
    return
  }

  app.dock.setIcon(iconPath)
}
