import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw"
import { DashboardCard } from "./DashboardCard"

export function ImageGallery() {
  return (
    <DashboardCard
      label="Gallery"
      data-stella-label="Image Gallery"
      data-stella-state="empty"
      actions={<RefreshCw size={12} aria-hidden="true" />}
    >
      <span className="home-sidebar-empty">
        Images you create in Stella will appear here.
      </span>
    </DashboardCard>
  )
}
