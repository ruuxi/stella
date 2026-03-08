import type { ChatContext } from '@/types/electron'

export type AttachmentRef = {
  id?: string
  url?: string
  mimeType?: string
}

export type SendMessageArgs = {
  text: string
  selectedText: string | null
  chatContext: ChatContext | null
  onClear: () => void
}
