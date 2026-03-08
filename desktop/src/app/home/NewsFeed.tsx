import { useState, useEffect } from "react"
import { DashboardCard } from "./DashboardCard"

export function NewsFeed() {
  const [newsHtml, setNewsHtml] = useState<string | null>(null)
  const [hasReceivedUpdate, setHasReceivedUpdate] = useState(false)

  useEffect(() => {
    return window.electronAPI?.news.onUpdate((html) => {
      setHasReceivedUpdate(true)
      setNewsHtml(html?.trim() ? html : null)
    })
  }, [])

  return (
    <DashboardCard
      label="Your News"
      data-stella-label="News Feed"
      data-stella-state={newsHtml ? "has content" : hasReceivedUpdate ? "empty" : "idle"}
    >
      {newsHtml ? (
        <div
          className="canvas-display"
          dangerouslySetInnerHTML={{ __html: newsHtml }}
        />
      ) : (
        <span className="home-sidebar-empty">
          {hasReceivedUpdate
            ? "Your next news briefing will appear here."
            : "Waiting for your first news briefing."}
        </span>
      )}
    </DashboardCard>
  )
}
