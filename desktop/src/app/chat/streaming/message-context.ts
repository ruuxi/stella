import type { ChatContext } from '@/shared/types/electron'
import type { AttachmentRef } from './chat-types'
import { resolveComposerContextState } from '../composer-context'

type BuildCombinedPromptArgs = {
  text: string
  selectedText: string | null
  chatContext: ChatContext | null
}

const buildWindowSnippet = (chatContext: ChatContext | null) => {
  if (!chatContext?.window) return ''

  return [chatContext.window.app, chatContext.window.title]
    .filter((part) => Boolean(part && part.trim()))
    .join(' - ')
}

export const hasComposerContext = (
  chatContext: ChatContext | null,
  selectedText: string | null,
) =>
  resolveComposerContextState(chatContext, selectedText).hasComposerContext

export const buildCombinedPrompt = ({
  text,
  selectedText,
  chatContext,
}: BuildCombinedPromptArgs) => {
  const selectedSnippet = selectedText?.trim() ?? ''
  const windowSnippet = buildWindowSnippet(chatContext)
  const hasScreenshotContext = Boolean(chatContext?.regionScreenshots?.length)
  const hasFileContext = Boolean(chatContext?.files?.length)
  const cleanedText = text.trim()

  const contextParts: string[] = []
  if (windowSnippet) {
    contextParts.push(
      `<active-window context="The user's currently focused window. May or may not be relevant to their request.">${windowSnippet}</active-window>`,
    )
  }

  if (chatContext?.windowText) {
    contextParts.push(
      `<window-content context="Text content extracted from the user's active window. Summarize or help the user with what they're looking at.">${chatContext.windowText}</window-content>`,
    )
  }

  if (selectedSnippet) {
    contextParts.push(`"${selectedSnippet}"`)
  }

  if (cleanedText) {
    contextParts.push(cleanedText)
  }

  return {
    combinedText: contextParts.join('\n\n'),
    hasScreenshotContext,
    hasFileContext,
    hasAttachments: hasScreenshotContext || hasFileContext,
  }
}

export const buildLocalScreenshotAttachments = (
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

export const buildLocalFileAttachments = (
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
