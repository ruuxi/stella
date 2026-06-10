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
      ...(screenshot.previewUrl ? { previewUrl: screenshot.previewUrl } : {}),
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

/**
 * Display copies (optimistic rows, stored chat events) swap the full
 * resolution data URL for the attach-time preview when one exists. The
 * model path keeps `url` untouched.
 */
export const toDisplayAttachments = (
  attachments: AttachmentRef[],
): AttachmentRef[] =>
  attachments.map(({ previewUrl, ...attachment }) => ({
    ...attachment,
    ...(previewUrl ? { url: previewUrl } : {}),
  }))
