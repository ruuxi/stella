import type { ChatContext } from '@/shared/types/electron'
import type { AttachmentRef } from './chat-types'

const buildLocalScreenshotAttachments = (
  chatContext: ChatContext | null,
): AttachmentRef[] =>
  (chatContext?.regionScreenshots ?? []).map((screenshot) => {
    const match = screenshot.dataUrl.match(
      /^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/,
    )

    return {
      url: screenshot.dataUrl,
      mimeType: match ? match[1] : 'image/png',
    }
  })

const buildLocalFileAttachments = (
  chatContext: ChatContext | null,
): AttachmentRef[] =>
  (chatContext?.files ?? []).map((file) => ({
    url: file.dataUrl,
    mimeType: file.mimeType,
  }))

/** Builds all local attachments (screenshots + files) from chat context. */
export const buildAllLocalAttachments = (
  chatContext: ChatContext | null,
): AttachmentRef[] => [
  ...buildLocalScreenshotAttachments(chatContext),
  ...buildLocalFileAttachments(chatContext),
]
