import { Component, type ReactNode, type ErrorInfo } from 'react'
import { dispatchStellaSendMessage } from '@/shared/lib/stella-send-message'

type Props = {
  children: ReactNode
  onRetry?: () => void
  source?: string
}

type State = {
  error: Error | null
}

export class WorkspaceErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[WorkspaceErrorBoundary]', error, info.componentStack)
  }

  handleRetry = () => {
    this.setState({ error: null })
    this.props.onRetry?.()
  }

  handleAskStella = () => {
    const { error } = this.state
    const name = error?.name ?? 'Error'
    const message = error?.message ?? 'Unknown error'
    const source = this.props.source ? ` in ${this.props.source}` : ''

    dispatchStellaSendMessage({
      text: `Something broke${source}: ${name}: ${message} — can you help me fix this?`,
    })
  }

  render() {
    const { error } = this.state

    if (error) {
      return (
        <div className="workspace-error">
          <div className="workspace-error-icon" aria-hidden="true">✦</div>
          <div className="workspace-error-title">Something went wrong</div>
          <div className="workspace-error-subtitle">
            This page ran into an unexpected issue.
          </div>
          <div className="workspace-error-actions">
            <button className="workspace-error-retry" onClick={this.handleRetry}>
              Try again
            </button>
            <button className="workspace-error-ask" onClick={this.handleAskStella}>
              Ask Stella to fix
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
