import { app, nativeImage } from 'electron'
import fs from 'fs'
import path from 'path'

const resolveProjectRoot = (electronDir: string) => path.resolve(electronDir, '..', '..')

const resolveDockIconPath = (electronDir: string) => {
  const projectRoot = resolveProjectRoot(electronDir)
  const preferredPaths = [
    path.join(projectRoot, 'build', 'icon.png'),
    path.join(projectRoot, 'dist', 'stella-app-icon.png'),
    path.join(projectRoot, 'public', 'stella-app-icon.png'),
  ]

  return preferredPaths.find((candidatePath) => fs.existsSync(candidatePath)) ?? preferredPaths[0]
}

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

  const iconPath = resolveDockIconPath(electronDir)
  if (!fs.existsSync(iconPath)) {
    return
  }

  const iconImage = nativeImage.createFromPath(iconPath)
  if (iconImage.isEmpty()) {
    return
  }

  app.dock.setIcon(iconImage)
}
