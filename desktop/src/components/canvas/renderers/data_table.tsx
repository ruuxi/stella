import { useState, useMemo } from 'react'
import { registerCanvas } from '../canvas-registry'
import type { CanvasPayload } from '@/app/state/canvas-state'

type SortDirection = 'asc' | 'desc'
type SortState = { key: string; dir: SortDirection } | null

type DataTableData = {
  columns?: string[]
  rows: Record<string, unknown>[]
  caption?: string
}

const DataTableRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  const data = canvas.data as DataTableData | undefined
  const [sort, setSort] = useState<SortState>(null)

  const rows = data?.rows ?? []
  const columns = useMemo(() => {
    if (data?.columns?.length) return data.columns
    if (rows.length === 0) return []
    // Auto-derive columns from first row keys
    return Object.keys(rows[0])
  }, [data?.columns, rows])

  const sorted = useMemo(() => {
    if (!sort) return rows
    return [...rows].sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [rows, sort])

  const handleSort = (key: string) => {
    setSort(prev => {
      if (prev?.key === key) {
        return prev.dir === 'asc' ? { key, dir: 'desc' } : null
      }
      return { key, dir: 'asc' }
    })
  }

  if (rows.length === 0) {
    return <div className="canvas-renderer-empty">No data to display</div>
  }

  return (
    <div className="canvas-data-table-wrap">
      {data?.caption && (
        <div className="canvas-data-table-caption">{data.caption}</div>
      )}
      <div className="canvas-data-table-scroll">
        <table className="canvas-data-table">
          <thead>
            <tr>
              {columns.map(col => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  className={sort?.key === col ? `sorted-${sort.dir}` : ''}
                >
                  <span>{col}</span>
                  {sort?.key === col && (
                    <span className="canvas-data-table-sort-icon">
                      {sort.dir === 'asc' ? '\u25B2' : '\u25BC'}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={i}>
                {columns.map(col => (
                  <td key={col}>{formatCell(row[col])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="canvas-data-table-footer">
        {rows.length} row{rows.length !== 1 ? 's' : ''}
      </div>
    </div>
  )
}

const formatCell = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

registerCanvas('data-table', DataTableRenderer)

export default DataTableRenderer
