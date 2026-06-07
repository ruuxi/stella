import { app, nativeImage, type NativeImage } from 'electron'
import fs from 'fs'
import path from 'path'

// applyDockIcon is called twice across startup (before and after init) as a
// deliberate macOS dock-reset defense. The PNG decode is identical each time,
// so cache the decoded image per path — only the dock.setIcon re-apply repeats.
const decodedIconCache = new Map<string, NativeImage>()

// Compiled main lives at desktop/dist-electron/desktop/electron, so the desktop
// package root (which holds build/, public/, dist/) is three levels up.
const resolveDesktopRoot = (electronDir: string) => path.resolve(electronDir, '..', '..', '..')

const resolveDockIconPath = (electronDir: string) => {
  const desktopRoot = resolveDesktopRoot(electronDir)
  const preferredPaths = [
    path.join(desktopRoot, 'build', 'icon.png'),
    path.join(desktopRoot, 'dist', 'stella-app-icon.png'),
    path.join(desktopRoot, 'public', 'stella-app-icon.png'),
  ]

  return preferredPaths.find((candidatePath) => fs.existsSync(candidatePath)) ?? preferredPaths[0]
}

export const resolveAppIconPath = (electronDir: string) => {
  const desktopRoot = resolveDesktopRoot(electronDir)
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(desktopRoot, 'build', 'icon.ico'),
          path.join(desktopRoot, 'dist', 'stella-app-icon.png'),
          path.join(desktopRoot, 'public', 'stella-app-icon.png'),
        ]
      : [
          path.join(desktopRoot, 'dist', 'stella-app-icon.png'),
          path.join(desktopRoot, 'public', 'stella-app-icon.png'),
        ]

  return candidates.find((candidatePath) => fs.existsSync(candidatePath)) ?? candidates[candidates.length - 1]
}

export const applyDockIcon = (electronDir: string) => {
  if (process.platform !== 'darwin' || !app.dock) {
    return
  }

  const iconPath = resolveDockIconPath(electronDir)
  if (!fs.existsSync(iconPath)) {
    return
  }

  let iconImage = decodedIconCache.get(iconPath)
  if (!iconImage) {
    iconImage = nativeImage.createFromPath(iconPath)
    if (iconImage.isEmpty()) {
      return
    }
    decodedIconCache.set(iconPath, iconImage)
  }

  app.dock.setIcon(iconImage)
}
