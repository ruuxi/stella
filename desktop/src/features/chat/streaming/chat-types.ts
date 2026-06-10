import type { MessageMetadata } from '@/features/chat/lib/event-transforms'
import type { ChatContext } from '@/shared/types/electron'

export type AttachmentRef = {
  id?: string
  url?: string
  mimeType?: string
  /** Downscaled data URL used for display; `url` stays full-resolution for the model. */
  previewUrl?: string
}

export type SendMessageArgs = {
  text: string
  selectedText: string | null
  chatContext: ChatContext | null
  onClear: () => void
  metadata?: MessageMetadata
}
