import { ipcMain, webContents, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { PiHostRunner } from '../../pi-host-runner.js'
import {
  getLastGitFeatureId,
  listRecentGitFeatures,
  revertGitFeature,
} from '../../self-mod/git.js'

type AgentHandlersOptions = {
  getPiHostRunner: () => PiHostRunner | null
  isHostAuthAuthenticated: () => boolean
  frontendRoot: string
  assertPrivilegedSender: (event: IpcMainEvent | IpcMainInvokeEvent, channel: string) => boolean
}

type AgentEventPayload = {
  type: 'stream' | 'tool-start' | 'tool-end' | 'error' | 'end'
  runId: string
  seq: number
  chunk?: string
  toolCallId?: string
  toolName?: string
  resultPreview?: string
  error?: string
  fatal?: boolean
  finalText?: string
  persisted?: boolean
  selfModApplied?: { featureId: string; files: string[]; batchIndex: number }
}

const AGENT_EVENT_BUFFER_LIMIT = 1000
const AGENT_EVENT_BUFFER_TTL_MS = 10 * 60 * 1000

export const registerAgentHandlers = (options: AgentHandlersOptions) => {
  const agentRunOwners = new Map<string, number>()
  const agentEventBuffers = new Map<
    string,
    {
      events: AgentEventPayload[]
      updatedAt: number
    }
  >()

  const pruneAgentEventBuffers = () => {
    const now = Date.now()
    for (const [runId, buffer] of agentEventBuffers.entries()) {
      if (agentRunOwners.has(runId)) continue
      if (now - buffer.updatedAt > AGENT_EVENT_BUFFER_TTL_MS) {
        agentEventBuffers.delete(runId)
      }
    }
  }

  const bufferAgentEvent = (runId: string, event: AgentEventPayload) => {
    const existing = agentEventBuffers.get(runId)
    if (existing) {
      existing.events.push(event)
      if (existing.events.length > AGENT_EVENT_BUFFER_LIMIT) {
        existing.events.splice(0, existing.events.length - AGENT_EVENT_BUFFER_LIMIT)
      }
      existing.updatedAt = Date.now()
      return
    }

    agentEventBuffers.set(runId, {
      events: [event],
      updatedAt: Date.now(),
    })
  }

  const emitAgentEvent = (runId: string, event: AgentEventPayload, targetWebContentsId?: number) => {
    bufferAgentEvent(runId, event)
    pruneAgentEventBuffers()
    const receiverId = targetWebContentsId ?? agentRunOwners.get(runId)
    if (receiverId == null) {
      return
    }
    const receiver = webContents.fromId(receiverId)
    if (receiver && !receiver.isDestroyed()) {
      receiver.send('agent:event', event)
    }
  }

  ipcMain.handle('agent:healthCheck', async () => {
    const piHostRunner = options.getPiHostRunner()
    if (!piHostRunner) {
      return null
    }
    const rawResult = piHostRunner.agentHealthCheck()
    const result =
      rawResult?.ready === false &&
      rawResult.reason === 'Missing proxy token' &&
      !options.isHostAuthAuthenticated()
        ? { ...rawResult, reason: 'Awaiting auth token' }
        : rawResult

    return result
  })

  ipcMain.handle('agent:getActiveRun', async () => {
    const piHostRunner = options.getPiHostRunner()
    if (!piHostRunner) return null
    const health = piHostRunner.agentHealthCheck()
    if (!health?.ready) return null
    return piHostRunner.getActiveOrchestratorRun()
  })

  ipcMain.handle('agent:resume', async (_event, payload: { runId: string; lastSeq: number }) => {
    pruneAgentEventBuffers()
    const runId = typeof payload.runId === 'string' ? payload.runId : ''
    const lastSeq = Number.isFinite(payload.lastSeq) ? payload.lastSeq : 0
    if (!runId) {
      return { events: [] as AgentEventPayload[], exhausted: true }
    }
    const buffer = agentEventBuffers.get(runId)
    if (!buffer) {
      return { events: [] as AgentEventPayload[], exhausted: true }
    }
    const oldestSeq = buffer.events[0]?.seq ?? null
    const exhausted = oldestSeq !== null && lastSeq < oldestSeq - 1
    return {
      events: buffer.events.filter((event) => event.seq > lastSeq),
      exhausted,
    }
  })

  ipcMain.handle('agent:startChat', async (event, payload: {
    conversationId: string
    userMessageId: string
    userPrompt: string
    agentType?: string
    storageMode?: 'cloud' | 'local'
  }) => {
    if (!options.assertPrivilegedSender(event, 'agent:startChat')) {
      throw new Error('Blocked untrusted request.')
    }
    const piHostRunner = options.getPiHostRunner()
    if (!piHostRunner) {
      throw new Error('Pi runtime not available')
    }

    const healthCheck = piHostRunner.agentHealthCheck()
    if (!healthCheck?.ready) {
      throw new Error('Agent runtime not ready')
    }

    const senderWebContentsId = event.sender.id
    const result = await piHostRunner.handleLocalChat(payload, {
      onStream: (ev) => emitAgentEvent(ev.runId, { type: 'stream', ...ev }, senderWebContentsId),
      onToolStart: (ev) => emitAgentEvent(ev.runId, { type: 'tool-start', ...ev }, senderWebContentsId),
      onToolEnd: (ev) => emitAgentEvent(ev.runId, { type: 'tool-end', ...ev }, senderWebContentsId),
      onError: (ev) => emitAgentEvent(ev.runId, { type: 'error', ...ev }, senderWebContentsId),
      onEnd: (ev) => {
        emitAgentEvent(ev.runId, { type: 'end', ...ev }, senderWebContentsId)
        setTimeout(() => {
          agentRunOwners.delete(ev.runId)
          pruneAgentEventBuffers()
        }, 60_000)
      },
    })

    agentRunOwners.set(result.runId, senderWebContentsId)
    return result
  })

  ipcMain.on('agent:cancelChat', (event, runId: string) => {
    if (!options.assertPrivilegedSender(event, 'agent:cancelChat')) {
      return
    }
    const piHostRunner = options.getPiHostRunner()
    if (piHostRunner && typeof runId === 'string') {
      piHostRunner.cancelLocalChat(runId)
      agentRunOwners.delete(runId)
    }
  })

  ipcMain.handle('selfmod:revert', async (event, payload: { featureId?: string; steps?: number }) => {
    if (!options.assertPrivilegedSender(event, 'selfmod:revert')) {
      throw new Error('Blocked untrusted request.')
    }
    return await revertGitFeature({
      repoRoot: options.frontendRoot,
      featureId: payload.featureId,
      steps: payload.steps,
    })
  })

  ipcMain.handle('selfmod:lastFeature', async (event) => {
    if (!options.assertPrivilegedSender(event, 'selfmod:lastFeature')) {
      throw new Error('Blocked untrusted request.')
    }
    return await getLastGitFeatureId(options.frontendRoot)
  })

  ipcMain.handle('selfmod:recentFeatures', async (
    event,
    payload: { limit?: number } | undefined,
  ) => {
    if (!options.assertPrivilegedSender(event, 'selfmod:recentFeatures')) {
      throw new Error('Blocked untrusted request.')
    }
    const limit = Number(payload?.limit ?? 8)
    return await listRecentGitFeatures(options.frontendRoot, limit)
  })
}
