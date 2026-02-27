import type { ReactNode } from "react"

type DashboardCardProps = {
  label?: string
  actions?: ReactNode
  children: ReactNode
}

export function DashboardCard({ label, actions, children }: DashboardCardProps) {
  return (
    <div className="dashboard-card">
      {(label || actions) && (
        <div className="dashboard-card-header">
          {label && <span className="dashboard-card-label">{label}</span>}
          {actions && <div className="dashboard-card-actions">{actions}</div>}
        </div>
      )}
      <div className="dashboard-card-body">
        {children}
      </div>
    </div>
  )
}
