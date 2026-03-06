import { DashboardCard } from "./DashboardCard"

const SKELETON_WIDTHS = ["75%", "90%", "60%", "85%", "70%", "80%"]
const SOURCE_WIDTHS = ["30%", "40%", "25%", "35%", "28%", "32%"]

export function NewsFeed() {
  return (
    <DashboardCard label="Your News" data-stella-label="News Feed" data-stella-state="placeholder">
      <div className="news-feed-list">
        {SKELETON_WIDTHS.map((width, i) => (
          <div key={i} className="news-feed-item">
            <div
              className="skeleton-line"
              style={{ width, animationDelay: `${i * 0.15}s` }}
            />
            <div
              className="skeleton-line-sm"
              style={{ width: SOURCE_WIDTHS[i], animationDelay: `${i * 0.15 + 0.1}s` }}
            />
          </div>
        ))}
      </div>
      <span className="news-feed-footnote">
        Personalized news based on your interests
      </span>
    </DashboardCard>
  )
}
