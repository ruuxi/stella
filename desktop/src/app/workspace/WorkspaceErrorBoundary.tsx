import { Component, type ReactNode, type ErrorInfo } from 'react'

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

  render() {
    const { error } = this.state

    if (error) {
      return (
        <div className="canvas-error">
          <div className="canvas-error-title">This component ran into a problem</div>
          <button className="canvas-error-retry" onClick={this.handleRetry}>
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
