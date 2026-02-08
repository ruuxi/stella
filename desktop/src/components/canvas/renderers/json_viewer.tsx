import { useState, useCallback } from 'react'
import { registerCanvas } from '../canvas-registry'
import type { CanvasPayload } from '@/app/state/canvas-state'

const JsonViewerRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  const [expandAll, setExpandAll] = useState(false)

  return (
    <div className="canvas-json-viewer">
      <div className="canvas-json-toolbar">
        <button
          className="canvas-json-btn"
          onClick={() => setExpandAll(true)}
        >
          Expand All
        </button>
        <button
          className="canvas-json-btn"
          onClick={() => setExpandAll(false)}
        >
          Collapse All
        </button>
      </div>
      <div className="canvas-json-tree">
        <JsonNode value={canvas.data} depth={0} expandAll={expandAll} />
      </div>
    </div>
  )
}

type JsonNodeProps = {
  label?: string
  value: unknown
  depth: number
  expandAll: boolean
}

const JsonNode = ({ label, value, depth, expandAll }: JsonNodeProps) => {
  const [open, setOpen] = useState(() => depth < 2)

  // Respond to expand/collapse all
  const isOpen = expandAll ? true : open

  const toggle = useCallback(() => setOpen(prev => !prev), [])

  if (value === null) {
    return <JsonLeaf label={label} value="null" className="json-null" />
  }

  if (value === undefined) {
    return <JsonLeaf label={label} value="undefined" className="json-undefined" />
  }

  if (typeof value === 'boolean') {
    return <JsonLeaf label={label} value={String(value)} className="json-boolean" />
  }

  if (typeof value === 'number') {
    return <JsonLeaf label={label} value={String(value)} className="json-number" />
  }

  if (typeof value === 'string') {
    return <JsonLeaf label={label} value={`"${value}"`} className="json-string" />
  }

  if (Array.isArray(value)) {
    return (
      <div className="json-node" style={{ '--json-depth': depth } as React.CSSProperties}>
        <div className="json-bracket-row" onClick={toggle}>
          <span className="json-toggle">{isOpen ? '\u25BC' : '\u25B6'}</span>
          {label !== undefined && <span className="json-key">{label}: </span>}
          <span className="json-bracket">[</span>
          {!isOpen && <span className="json-collapsed">{value.length} items</span>}
          {!isOpen && <span className="json-bracket">]</span>}
        </div>
        {isOpen && (
          <>
            {value.map((item, i) => (
              <JsonNode key={i} label={String(i)} value={item} depth={depth + 1} expandAll={expandAll} />
            ))}
            <div className="json-bracket-close">
              <span className="json-bracket">]</span>
            </div>
          </>
        )}
      </div>
    )
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return (
      <div className="json-node" style={{ '--json-depth': depth } as React.CSSProperties}>
        <div className="json-bracket-row" onClick={toggle}>
          <span className="json-toggle">{isOpen ? '\u25BC' : '\u25B6'}</span>
          {label !== undefined && <span className="json-key">{label}: </span>}
          <span className="json-bracket">{'{'}</span>
          {!isOpen && <span className="json-collapsed">{entries.length} keys</span>}
          {!isOpen && <span className="json-bracket">{'}'}</span>}
        </div>
        {isOpen && (
          <>
            {entries.map(([k, v]) => (
              <JsonNode key={k} label={k} value={v} depth={depth + 1} expandAll={expandAll} />
            ))}
            <div className="json-bracket-close">
              <span className="json-bracket">{'}'}</span>
            </div>
          </>
        )}
      </div>
    )
  }

  return <JsonLeaf label={label} value={String(value)} className="json-unknown" />
}

const JsonLeaf = ({ label, value, className }: { label?: string; value: string; className: string }) => (
  <div className="json-leaf">
    {label !== undefined && <span className="json-key">{label}: </span>}
    <span className={className}>{value}</span>
  </div>
)

registerCanvas('json-viewer', JsonViewerRenderer)

export default JsonViewerRenderer
