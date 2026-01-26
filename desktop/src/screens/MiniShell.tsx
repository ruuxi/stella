import { useUiState } from '../app/state/ui-state'
import { getElectronApi } from '../services/electron'
import type { UiMode } from '../types/ui'

const modes: UiMode[] = ['ask', 'chat', 'voice']

export const MiniShell = () => {
  const { state, setMode, setConversationId, setWindow } = useUiState()
  const hostStatus = getElectronApi() ? 'Local Host connected' : 'Local Host disconnected'

  const onNewConversation = () => {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}`
    setConversationId(id)
  }

  return (
    <div className="window-shell mini">
      <div className="mini-top">
        <div className="header-title">
          <span className="app-badge">Stellar</span>
          <span className="header-subtitle">Mini prompt</span>
          <span className="host-status">{hostStatus}</span>
        </div>
        <div className="mode-toggle compact" role="tablist" aria-label="Assistant mode">
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              data-active={state.mode === mode}
              onClick={() => setMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
        <button className="primary-button" type="button" onClick={() => setWindow('full')}>
          Expand
        </button>
      </div>

      <div className="mini-input">
        <input className="composer-input" placeholder="Ask Stellar, search, or run a command..." />
        <button className="ghost-button" type="button">
          Send
        </button>
      </div>

      <div className="mini-thread">
        <div className="panel-header">
          <div className="panel-title">Thread</div>
          <div className="panel-meta">{state.conversationId ?? 'No conversation yet'}</div>
        </div>
        <div className="panel-content compact">
          <div className="thread-placeholder">
            <div className="thread-line short" />
            <div className="thread-line" />
          </div>
          <button className="ghost-button" type="button" onClick={onNewConversation}>
            New thread
          </button>
        </div>
      </div>
    </div>
  )
}
