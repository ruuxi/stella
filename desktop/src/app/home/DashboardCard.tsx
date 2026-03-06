import type { HTMLAttributes, ReactNode } from "react"

type DashboardCardProps = HTMLAttributes<HTMLDivElement> & {
  label?: string
  actions?: ReactNode
  children: ReactNode
}

export function DashboardCard({ label, actions, children, className, ...rest }: DashboardCardProps) {
  return (
    <div className={className ? `dashboard-card ${className}` : "dashboard-card"} {...rest}>
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
