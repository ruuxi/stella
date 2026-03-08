import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StellaHostRunner } from '../stella-host-runner.js'
import { LocalSchedulerService } from './local-scheduler-service.js'

const tempHomes: string[] = []

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stella-local-scheduler-'))
  tempHomes.push(dir)
  return dir
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe('LocalSchedulerService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-06T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates the local scheduler state file on startup and reloads persisted records', () => {
    const stellaHome = createTempHome()
    const statePath = path.join(stellaHome, 'state', 'local-scheduler.json')

    const service = new LocalSchedulerService({
      stellaHome,
      getRunner: () => null,
    })

    service.start()
    expect(fs.existsSync(statePath)).toBe(true)

    const cronJob = service.addCronJob({
      name: 'Morning review',
      conversationId: 'conv-startup',
      sessionTarget: 'main',
      schedule: {
        kind: 'every',
        everyMs: 60_000,
      },
      payload: {
        kind: 'systemEvent',
        text: 'Check in on open tasks.',
      },
    })

    const heartbeat = service.upsertHeartbeat({
      conversationId: 'conv-startup',
      intervalMs: 120_000,
      checklist: '- Check for anything urgent',
    })

    service.stop()

    const reloaded = new LocalSchedulerService({
      stellaHome,
      getRunner: () => null,
    })
    reloaded.start()

    expect(reloaded.listCronJobs()).toEqual([cronJob])
    expect(reloaded.listHeartbeats()).toEqual([heartbeat])

    reloaded.stop()
  })

  it('executes a one-shot cron job locally and emits a local assistant event', async () => {
    const stellaHome = createTempHome()
    const runAutomationTurn = vi.fn().mockResolvedValue({
      status: 'ok',
      finalText: 'Call the dentist this afternoon.',
    })

    const service = new LocalSchedulerService({
      stellaHome,
      getRunner: () =>
        ({
          runAutomationTurn,
        }) as unknown as StellaHostRunner,
    })

    service.start()
    const job = service.addCronJob({
      name: 'Dentist reminder',
      conversationId: 'conv-1',
      sessionTarget: 'main',
      schedule: {
        kind: 'at',
        atMs: Date.now(),
      },
      payload: {
        kind: 'systemEvent',
        text: 'Reminder: you wanted to call the dentist today.',
      },
    })

    await vi.advanceTimersByTimeAsync(300)

    expect(runAutomationTurn).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userPrompt: 'Reminder: you wanted to call the dentist today.',
      agentType: 'orchestrator',
    })

    const storedJob = service.listCronJobs().find((entry) => entry.id === job.id)
    expect(storedJob?.enabled).toBe(false)
    expect(storedJob?.lastStatus).toBe('ok')
    expect(storedJob?.lastOutputPreview).toContain('Call the dentist')

    const events = service.listConversationEvents('conv-1', 10)
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      text: 'Call the dentist this afternoon.',
      source: 'cron',
      cronJobId: job.id,
      cronJobName: 'Dentist reminder',
    })

    service.stop()
  })

  it('runs heartbeats locally and suppresses duplicate delivery within the dedupe window', async () => {
    const stellaHome = createTempHome()
    const runAutomationTurn = vi.fn().mockResolvedValue({
      status: 'ok',
      finalText: 'Inbox is clear.',
    })

    const service = new LocalSchedulerService({
      stellaHome,
      getRunner: () =>
        ({
          runAutomationTurn,
        }) as unknown as StellaHostRunner,
    })

    service.start()
    service.upsertHeartbeat({
      conversationId: 'conv-2',
      intervalMs: 60_000,
      checklist: '- Check for anything urgent',
    })
    service.runHeartbeat('conv-2')

    await vi.advanceTimersByTimeAsync(300)

    expect(service.listConversationEvents('conv-2', 10)).toHaveLength(1)

    service.runHeartbeat('conv-2')
    await vi.advanceTimersByTimeAsync(300)

    const config = service.getHeartbeatConfig('conv-2')
    expect(config?.lastStatus).toBe('skipped:duplicate')
    expect(service.listConversationEvents('conv-2', 10)).toHaveLength(1)

    service.stop()
  })
})
