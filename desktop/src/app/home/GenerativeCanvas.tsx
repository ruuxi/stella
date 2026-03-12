import { useState, useEffect } from "react"
import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation"
import { DashboardCard } from "./DashboardCard"
import { sanitizeHtmlFragment } from "@/shared/lib/safe-html"

function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return "Good morning"
  if (h < 17) return "Good afternoon"
  return "Good evening"
}

export function GenerativeCanvas() {
  const [displayHtml, setDisplayHtml] = useState<string | null>(null)

  useEffect(() => {
    return window.electronAPI?.display.onUpdate((html) => {
      setDisplayHtml(sanitizeHtmlFragment(html))
    })
  }, [])

  return (
    <DashboardCard
      data-stella-label="Canvas"
      data-stella-state={displayHtml ? "has content" : "idle"}
    >
      {displayHtml ? (
        <div
          className="canvas-display"
          dangerouslySetInnerHTML={{ __html: displayHtml }}
        />
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

