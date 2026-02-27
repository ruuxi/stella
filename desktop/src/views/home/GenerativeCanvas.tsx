import { StellaAnimation } from "@/components/StellaAnimation"
import { DashboardCard } from "./DashboardCard"

export function GenerativeCanvas() {
  return (
    <DashboardCard>
      <div className="canvas-container">
        <div className="canvas-rings-outer" />
        <div className="canvas-rings" />
        <div className="home-stella-orb" style={{ width: 140, height: 140 }}>
          <StellaAnimation width={80} height={56} />
        </div>
        <span className="canvas-label">Generative Canvas</span>
      </div>
    </DashboardCard>
  )
}
