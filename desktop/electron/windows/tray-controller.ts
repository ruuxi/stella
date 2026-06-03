import { Menu, Tray, nativeImage } from 'electron'
import fs from 'fs'
import path from 'path'

type TrayControllerOptions = {
  electronDir: string
  onShowWindow: () => void
  onQuit: () => void
}

const resolveTrayIconPath = (electronDir: string): string | null => {
  const projectRoot = path.resolve(electronDir, '..', '..')
  const candidates = [
    path.join(projectRoot, 'build', 'icon.ico'),
    path.join(projectRoot, 'build', 'icon.png'),
    path.join(projectRoot, 'public', 'stella-app-icon.png'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

/**
 * Windows system-tray presence so the app can keep running after the user
 * closes ("X") the main window. The tray icon restores the window on click
 * and exposes an explicit Quit — without that, hiding-on-close would strand
 * users with no way to either get the window back or fully exit.
 */
export class TrayController {
  private tray: Tray | null = null
  private hintShown = false

  constructor(private readonly options: TrayControllerOptions) {}

  create(): Tray | null {
    if (this.tray && !this.tray.isDestroyed()) {
      return this.tray
    }

    const iconPath = resolveTrayIconPath(this.options.electronDir)
    const image = iconPath
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty()

    const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
    tray.setToolTip('Stella')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open Stella',
          click: () => this.options.onShowWindow(),
        },
        { type: 'separator' },
        {
          label: 'Quit Stella',
          click: () => this.options.onQuit(),
        },
      ]),
    )
    // Single click is the expected "bring it back" gesture on Windows; the
    // double-click is wired too so either habit works.
    tray.on('click', () => this.options.onShowWindow())
    tray.on('double-click', () => this.options.onShowWindow())

    this.tray = tray
    return tray
  }

  /**
   * Shown once per run the first time the user closes the window to the
   * tray, so the window "disappearing" doesn't read as a crash or a quit.
   */
  notifyMinimizedToTray() {
    if (this.hintShown) return
    this.hintShown = true
    if (!this.tray || this.tray.isDestroyed()) return
    if (process.platform !== 'win32') return
    this.tray.displayBalloon({
      title: 'Stella is still running',
      content: 'Stella stays in your system tray. Click the icon to reopen it.',
    })
  }

  destroy() {
    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy()
    }
    this.tray = null
  }
}
