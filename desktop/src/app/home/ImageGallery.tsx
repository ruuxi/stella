import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw"
import ImageIcon from "lucide-react/dist/esm/icons/image"
import { DashboardCard } from "./DashboardCard"

export function ImageGallery() {
  return (
    <DashboardCard
      label="Gallery"
      data-stella-label="Image Gallery"
      data-stella-state="empty"
      actions={
        <button className="gallery-refresh-btn" disabled aria-label="Refresh gallery">
          <RefreshCw size={12} />
        </button>
      }
    >
      <div className="gallery-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="gallery-placeholder">
            <ImageIcon size={20} />
          </div>
        ))}
      </div>
      <span className="gallery-footnote">
        AI-generated images will appear here
      </span>
    </DashboardCard>
  )
}
