import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalChatService } from '../../../electron/services/local-chat-service.js'

const tempHomes: string[] = []

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stella-local-chat-'))
  tempHomes.push(dir)
  return dir
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe('LocalChatService', () => {
  it('persists transcript events in SQLite and mirrors each conversation to JSONL', () => {
    const stellaHome = createTempHome()
    const service = new LocalChatService(stellaHome)

    service.appendEvent({
      conversationId: 'conv-1',
      type: 'assistant_message',
      eventId: 'a-2',
      timestamp: 2,
      payload: { text: 'second' },
    })
    service.appendEvent({
      conversationId: 'conv-1',
      type: 'user_message',
      eventId: 'u-1',
      timestamp: 1,
      deviceId: 'device-1',
      payload: { text: 'first' },
    })

    expect(service.getEventCount('conv-1')).toBe(2)
    expect(service.listEvents('conv-1', 10).map((event) => event._id)).toEqual([
      'u-1',
      'a-2',
    ])

    const transcriptPath = path.join(
      stellaHome,
      'state',
      'local-chat',
      'transcripts',
      'conv-1.jsonl',
    )
    const transcriptLines = fs.readFileSync(transcriptPath, 'utf-8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { _id: string; conversationId: string })

    expect(transcriptLines).toHaveLength(2)
    expect(transcriptLines[0]).toMatchObject({ _id: 'u-1', conversationId: 'conv-1' })
    expect(transcriptLines[1]).toMatchObject({ _id: 'a-2', conversationId: 'conv-1' })

    service.close()
  })

  it('trims oversized conversations and keeps the JSONL mirror in sync', () => {
    const stellaHome = createTempHome()
    const service = new LocalChatService(stellaHome)

    for (let index = 1; index <= 2002; index += 1) {
      service.appendEvent({
        conversationId: 'conv-trim',
        type: 'user_message',
        eventId: `e-${index}`,
        timestamp: index,
        payload: { text: `message-${index}` },
      })
    }

    const events = service.listEvents('conv-trim', 5000)
    expect(events).toHaveLength(2000)
    expect(events[0]?._id).toBe('e-3')
    expect(events.at(-1)?._id).toBe('e-2002')

    const transcriptPath = path.join(
      stellaHome,
      'state',
      'local-chat',
      'transcripts',
      'conv-trim.jsonl',
    )
    const transcriptLines = fs.readFileSync(transcriptPath, 'utf-8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { _id: string })

    expect(transcriptLines).toHaveLength(2000)
    expect(transcriptLines[0]?._id).toBe('e-3')
    expect(transcriptLines.at(-1)?._id).toBe('e-2002')

    service.close()
  })

  it('builds sync messages and persists checkpoints plus the default conversation id', () => {
    const stellaHome = createTempHome()
    const service = new LocalChatService(stellaHome)

    service.appendEvent({
      conversationId: 'conv-sync',
      type: 'user_message',
      eventId: 'u-1',
      timestamp: 10,
      deviceId: 'device-1',
      payload: { text: 'hello' },
    })
    service.appendEvent({
      conversationId: 'conv-sync',
      type: 'assistant_message',
      eventId: 'a-2',
      timestamp: 11,
      payload: { text: 'hi' },
    })
    service.setSyncCheckpoint('conv-sync', 'a-2')

    const defaultConversationId = service.getOrCreateDefaultConversationId()
    expect(service.getOrCreateDefaultConversationId()).toBe(defaultConversationId)
    expect(service.getSyncCheckpoint('conv-sync')).toBe('a-2')
    expect(service.listSyncMessages('conv-sync', 10)).toEqual([
      {
        localMessageId: 'u-1',
        role: 'user',
        text: 'hello',
        timestamp: 10,
        deviceId: 'device-1',
      },
      {
        localMessageId: 'a-2',
        role: 'assistant',
        text: 'hi',
        timestamp: 11,
      },
    ])

    service.close()

    const reopened = new LocalChatService(stellaHome)
    expect(reopened.getOrCreateDefaultConversationId()).toBe(defaultConversationId)
    expect(reopened.getSyncCheckpoint('conv-sync')).toBe('a-2')
    reopened.close()
  })
})
