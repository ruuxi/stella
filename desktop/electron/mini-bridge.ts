export type MiniBridgeEventRecord = {
  _id: string
  timestamp: number
  type: string
  deviceId?: string
  requestId?: string
  targetDeviceId?: string
  payload?: Record<string, unknown>
  channelEnvelope?: Record<string, unknown>
}

export type MiniBridgeSnapshot = {
  conversationId: string | null
  events: MiniBridgeEventRecord[]
  streamingText: string
  reasoningText: string
  isStreaming: boolean
  pendingUserMessageId: string | null
}

export type MiniBridgeRequest =
  | {
      type: 'query:snapshot'
      conversationId: string | null
    }
  | {
      type: 'mutation:sendMessage'
      conversationId: string
      text: string
      selectedText: string | null
      chatContext: {
        window: {
          title: string
          app: string
          bounds: { x: number; y: number; width: number; height: number }
        } | null
        browserUrl?: string | null
        selectedText?: string | null
        regionScreenshots?: {
          dataUrl: string
          width: number
          height: number
        }[]
        capturePending?: boolean
      } | null
    }

export type MiniBridgeResponse =
  | {
      type: 'query:snapshot'
      snapshot: MiniBridgeSnapshot
    }
  | {
      type: 'mutation:sendMessage'
      accepted: boolean
    }
  | {
      type: 'error'
      message: string
    }

export type MiniBridgeRequestEnvelope = {
  requestId: string
  request: MiniBridgeRequest
}

export type MiniBridgeResponseEnvelope = {
  requestId: string
  response: MiniBridgeResponse
}

export type MiniBridgeUpdate = {
  type: 'snapshot'
  snapshot: MiniBridgeSnapshot
}
