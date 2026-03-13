import { useState, useEffect, useRef, useCallback } from "react"
import morphdom from "morphdom"
import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation"
import { DashboardCard } from "./DashboardCard"

function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return "Good morning"
  if (h < 17) return "Good afternoon"
  return "Good evening"
}

export function GenerativeCanvas() {
  const [hasContent, setHasContent] = useState(false)
  const displayRef = useRef<HTMLDivElement>(null)
  const pendingHtmlRef = useRef<string | null>(null)

  const applyHtml = useCallback((html: string) => {
    const container = displayRef.current
    if (!container) {
      // Ref not mounted yet — stash HTML for when the display div appears
      pendingHtmlRef.current = html
      setHasContent(true)
      return
    }

    // Build a target node for morphdom to diff against
    const target = document.createElement("div")
    target.className = "canvas-display"
    target.innerHTML = html

    morphdom(container, target, {
      onBeforeElUpdated(fromEl, toEl) {
        if (fromEl.isEqualNode(toEl)) return false
        return true
      },
      onNodeAdded(node) {
        if (
          node.nodeType === 1 &&
          (node as Element).tagName !== "STYLE" &&
          (node as Element).tagName !== "SCRIPT"
        ) {
          ;(node as HTMLElement).style.animation = "_canvasFadeIn 0.3s ease both"
        }
        return node
      },
    })

    // Execute scripts after morphdom diff (scripts are inert after innerHTML)
    container.querySelectorAll("script").forEach((old) => {
      const fresh = document.createElement("script")

      // Preserve all attributes (type=module, onload, crossorigin, integrity, etc.)
      for (const { name, value } of Array.from(old.attributes)) {
        fresh.setAttribute(name, value)
      }

      if (!old.src) {
        fresh.textContent = old.textContent
      }

      old.parentNode?.replaceChild(fresh, old)
    })
  }, [])

  // Apply pending HTML once the display div mounts
  useEffect(() => {
    if (hasContent && displayRef.current && pendingHtmlRef.current) {
      const html = pendingHtmlRef.current
      pendingHtmlRef.current = null
      applyHtml(html)
    }
  }, [hasContent, applyHtml])

  useEffect(() => {
    return window.electronAPI?.display.onUpdate((html) => {
      applyHtml(html)
    })
  }, [applyHtml])

  return (
    <DashboardCard
      data-stella-label="Canvas"
      data-stella-state={hasContent ? "has content" : "idle"}
    >
      {hasContent ? (
        <div ref={displayRef} className="canvas-display" />
      ) : (
        <div className="canvas-container">
          <div className="canvas-rings-outer" />
          <div className="canvas-rings" />
          <div className="home-stella-orb">
            <StellaAnimation width={40} height={30} />
          </div>
          <div className="canvas-footer">
            <span className="canvas-greeting">{getGreeting()}</span>
          </div>
        </div>
      )}
    </DashboardCard>
  )
}
