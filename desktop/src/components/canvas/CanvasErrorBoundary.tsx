import { Component, type ReactNode, type ErrorInfo } from 'react'

type Props = {
  children: ReactNode
  onRetry?: () => void
  source?: string
}

type State = {
  error: Error | null
}

export class CanvasErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[CanvasErrorBoundary]', error, info.componentStack)
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
          <div className="canvas-error-title">Component Error</div>
          <div className="canvas-error-message">{error.message}</div>
          {error.stack && (
            <details>
              <summary style={{ fontSize: 11, color: 'var(--text-weak)', cursor: 'pointer' }}>
                Stack trace
              </summary>
              <div className="canvas-error-message" style={{ marginTop: 6, fontSize: 11 }}>
                {error.stack}
              </div>
            </details>
          )}
          <button className="canvas-error-retry" onClick={this.handleRetry}>
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
