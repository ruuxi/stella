import { StellaAnimation } from "@/app/shell/ascii-creature/StellaAnimation"
import { DashboardCard } from "./DashboardCard"

function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return "Good morning"
  if (h < 17) return "Good afternoon"
  return "Good evening"
}

export function GenerativeCanvas() {
  return (
    <DashboardCard>
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
    </DashboardCard>
  )
}

