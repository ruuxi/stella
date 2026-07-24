import type { MessageMetadata } from '@/features/chat/lib/event-transforms'
import type { ChatContext } from '@/shared/types/electron'

export type AttachmentRef = {
  id?: string
  url?: string
  mimeType?: string
  /** Downscaled data URL used for display; `url` stays full-resolution for the model. */
  previewUrl?: string
  /** Original filename; sent-message file chips render it verbatim. */
  name?: string
  size?: number
  /** Attachment discriminator; composer file attachments persist `"file"`. */
  kind?: string
  /** On-disk source path so the sent file chip can open the original. */
  path?: string
}

export type SendMessageArgs = {
  text: string
  selectedText: string | null
  chatContext: ChatContext | null
  onClear: () => void
  metadata?: MessageMetadata
}
