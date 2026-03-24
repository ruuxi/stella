/**
 * DisplayOverlay — global overlay for the agent Display tool.
 *
 * Listens to `display.onUpdate` from IPC. When HTML arrives,
 * the overlay opens and morphdom streams the content in.
 * Works from any view in the app.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import morphdom from "morphdom"
import "./display-overlay.css"

export function DisplayOverlay() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const applyHtml = useCallback((html: string) => {
    const container = containerRef.current
    if (!container) return

    const target = document.createElement("div")
    target.className = "display-overlay__content"
    target.innerHTML = html
    morphdom(container, target, {
      onBeforeElUpdated(fromEl, toEl) {
        if (fromEl.isEqualNode(toEl)) return false
        return true
      },
    })
  }, [])

  // Listen for Display tool updates
  useEffect(() => {
    return window.electronAPI?.display.onUpdate((html) => {
      setOpen(true)
      // Need a tick for the container ref to be in DOM if just opened
      requestAnimationFrame(() => applyHtml(html))
    })
  }, [applyHtml])

  // Event delegation for data-action clicks inside the overlay
  const handleClick = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest(
      "[data-action]",
    ) as HTMLElement | null
    if (!el) return
    const action = el.getAttribute("data-action")
    if (action === "send-message") {
      const prompt = el.getAttribute("data-prompt")
      if (prompt) {
        window.dispatchEvent(
          new CustomEvent("stella:send-message", { detail: { text: prompt } }),
        )
      }
    }
  }, [])

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  if (!open) return null

  return (
    <div className="display-overlay" onClick={handleClose}>
      <div
        className="display-overlay__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="display-overlay__close"
          onClick={handleClose}
          aria-label="Close"
        >
          ✕
        </button>
        <div
          ref={containerRef}
          className="display-overlay__content"
          onClick={handleClick}
        />
      </div>
    </div>
  )
}
