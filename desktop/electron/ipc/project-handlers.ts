import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron'
import type { DevProjectService } from '../services/dev-project-service.js'

type ProjectHandlersOptions = {
  devProjectService: DevProjectService
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean
}

export const registerProjectHandlers = (options: ProjectHandlersOptions) => {
  ipcMain.handle('projects:list', async (event) => {
    if (!options.assertPrivilegedSender(event, 'projects:list')) {
      throw new Error('Blocked untrusted request.')
    }
    return options.devProjectService.listProjects()
  })

  ipcMain.handle('projects:pickDirectory', async (event) => {
    if (!options.assertPrivilegedSender(event, 'projects:pickDirectory')) {
      throw new Error('Blocked untrusted request.')
    }

    const browserWindow = BrowserWindow.fromWebContents(event.sender)
    const dialogOptions: OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Choose a local project',
      buttonLabel: 'Use Project',
    }
    const selection = browserWindow
      ? await dialog.showOpenDialog(browserWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)

    if (selection.canceled || selection.filePaths.length === 0) {
      return {
        canceled: true,
        projects: await options.devProjectService.listProjects(),
      }
    }

    const result = await options.devProjectService.pickProjectDirectory(selection.filePaths[0])
    return {
      canceled: false,
      ...result,
    }
  })

  ipcMain.handle('projects:start', async (event, payload: { projectId?: string }) => {
    if (!options.assertPrivilegedSender(event, 'projects:start')) {
      throw new Error('Blocked untrusted request.')
    }
    const projectId = typeof payload?.projectId === 'string' ? payload.projectId.trim() : ''
    if (!projectId) {
      throw new Error('Project ID is required.')
    }
    return options.devProjectService.startProject(projectId)
  })

  ipcMain.handle('projects:stop', async (event, payload: { projectId?: string }) => {
    if (!options.assertPrivilegedSender(event, 'projects:stop')) {
      throw new Error('Blocked untrusted request.')
    }
    const projectId = typeof payload?.projectId === 'string' ? payload.projectId.trim() : ''
    if (!projectId) {
      throw new Error('Project ID is required.')
    }
    return options.devProjectService.stopProject(projectId)
  })
}
