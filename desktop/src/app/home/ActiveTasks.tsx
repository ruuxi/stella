import { DashboardCard } from "./DashboardCard"

type RunningTask = {
  id: string
  description: string
  agentType: string
  statusText?: string
}

type ActiveTasksProps = {
  tasks: RunningTask[]
}

export function ActiveTasks({ tasks }: ActiveTasksProps) {
  return (
    <DashboardCard label="Active Tasks" data-stella-label="Active Tasks" data-stella-state={`${tasks.length} running`}>
      <div className="home-tasks">
        {tasks.map((task) => (
          <div key={task.id} className="home-task-card">
            <div className="home-task-description">{task.description}</div>
            <div className="home-task-meta">
              <span className="home-task-agent-badge">{task.agentType}</span>
              {task.statusText && (
                <span className="home-task-status">{task.statusText}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </DashboardCard>
  )
}
