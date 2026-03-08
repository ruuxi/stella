import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { LocalChatService } from '../../services/local-chat-service.js'

type LocalChatHandlersOptions = {
  getLocalChatService: () => LocalChatService | null
  assertPrivilegedSender: (event: IpcMainEvent | IpcMainInvokeEvent, channel: string) => boolean
}

const broadcastUpdated = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('localChat:updated')
    }
  }
}

const getService = (options: LocalChatHandlersOptions) => {
  const service = options.getLocalChatService()
  if (!service) {
    throw new Error('Local chat service not available.')
  }
  return service
}

export const registerLocalChatHandlers = (options: LocalChatHandlersOptions) => {
  ipcMain.handle('localChat:listEvents', (event, payload: {
    conversationId?: string
    maxItems?: number
  }) => {
    if (!options.assertPrivilegedSender(event, 'localChat:listEvents')) {
      throw new Error('Blocked untrusted localChat:listEvents request.')
    }
    return getService(options).listEvents(
      payload?.conversationId ?? '',
      payload?.maxItems,
    )
  })

  ipcMain.handle('localChat:getEventCount', (event, payload: {
    conversationId?: string
  }) => {
    if (!options.assertPrivilegedSender(event, 'localChat:getEventCount')) {
      throw new Error('Blocked untrusted localChat:getEventCount request.')
    }
    return getService(options).getEventCount(payload?.conversationId ?? '')
  })

  ipcMain.handle('localChat:appendEvent', (event, payload: {
    conversationId?: string
    type?: string
    payload?: unknown
    deviceId?: string
    requestId?: string
    targetDeviceId?: string
    channelEnvelope?: unknown
    timestamp?: number
    eventId?: string
  }) => {
    if (!options.assertPrivilegedSender(event, 'localChat:appendEvent')) {
      throw new Error('Blocked untrusted localChat:appendEvent request.')
    }
    const result = getService(options).appendEvent({
      conversationId: payload?.conversationId ?? '',
      type: payload?.type ?? '',
      payload: payload?.payload,
      deviceId: payload?.deviceId,
      requestId: payload?.requestId,
      targetDeviceId: payload?.targetDeviceId,
      channelEnvelope: payload?.channelEnvelope,
      timestamp: payload?.timestamp,
      eventId: payload?.eventId,
    })
    broadcastUpdated()
    return result
  })

  ipcMain.handle('localChat:listSyncMessages', (event, payload: {
    conversationId?: string
    maxMessages?: number
  }) => {
    if (!options.assertPrivilegedSender(event, 'localChat:listSyncMessages')) {
      throw new Error('Blocked untrusted localChat:listSyncMessages request.')
    }
    return getService(options).listSyncMessages(
      payload?.conversationId ?? '',
      payload?.maxMessages,
    )
  })

  ipcMain.handle('localChat:getSyncCheckpoint', (event, payload: {
    conversationId?: string
  }) => {
    if (!options.assertPrivilegedSender(event, 'localChat:getSyncCheckpoint')) {
      throw new Error('Blocked untrusted localChat:getSyncCheckpoint request.')
    }
    return getService(options).getSyncCheckpoint(payload?.conversationId ?? '')
  })

  ipcMain.handle('localChat:setSyncCheckpoint', (event, payload: {
    conversationId?: string
    localMessageId?: string
  }) => {
    if (!options.assertPrivilegedSender(event, 'localChat:setSyncCheckpoint')) {
      throw new Error('Blocked untrusted localChat:setSyncCheckpoint request.')
    }
    getService(options).setSyncCheckpoint(
      payload?.conversationId ?? '',
      payload?.localMessageId ?? '',
    )
    return { ok: true }
  })

  ipcMain.handle('localChat:importLegacyData', (event, payload: {
    store?: {
      version?: number
      conversations?: Record<string, {
        id?: string
        updatedAt?: number
        events?: unknown[]
      }>
    } | null
    syncCheckpoints?: Record<string, unknown> | null
  }) => {
    if (!options.assertPrivilegedSender(event, 'localChat:importLegacyData')) {
      throw new Error('Blocked untrusted localChat:importLegacyData request.')
    }
    const result = getService(options).importLegacyData({
      store: payload?.store,
      syncCheckpoints: payload?.syncCheckpoints,
    })
    if (result.importedConversations > 0 || result.importedCheckpoints > 0) {
      broadcastUpdated()
    }
    return result
  })
}
