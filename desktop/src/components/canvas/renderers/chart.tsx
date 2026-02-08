import { useMemo } from 'react'
import {
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie, Cell,
  AreaChart, Area,
  ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { registerCanvas } from '../canvas-registry'
import type { CanvasPayload } from '@/app/state/canvas-state'

type ChartData = {
  type: 'bar' | 'line' | 'pie' | 'area' | 'scatter'
  data: Record<string, unknown>[]
  xKey?: string
  yKeys?: string[]
  title?: string
  colors?: string[]
}

const DEFAULT_COLORS = [
  'var(--primary)',
  'oklch(0.7 0.15 200)',
  'oklch(0.7 0.15 140)',
  'oklch(0.7 0.15 320)',
  'oklch(0.7 0.15 60)',
  'oklch(0.7 0.15 270)',
]

const ChartRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  const chartData = canvas.data as ChartData | undefined
  const { data = [], type = 'bar', xKey, yKeys, title, colors } = chartData ?? {}

  const resolvedColors = colors?.length ? colors : DEFAULT_COLORS

  // Auto-detect x/y keys from first row
  const { resolvedXKey, resolvedYKeys } = useMemo(() => {
    if (data.length === 0) return { resolvedXKey: '', resolvedYKeys: [] }
    const keys = Object.keys(data[0])
    const rx = xKey ?? keys.find(k => typeof data[0][k] === 'string') ?? keys[0]
    const ry = yKeys?.length
      ? yKeys
      : keys.filter(k => k !== rx && typeof data[0][k] === 'number')
    return { resolvedXKey: rx, resolvedYKeys: ry }
  }, [data, xKey, yKeys])

  if (data.length === 0) {
    return <div className="canvas-renderer-empty">No chart data</div>
  }

  return (
    <div className="canvas-chart-wrap">
      {title && <div className="canvas-chart-title">{title}</div>}
      <div className="canvas-chart-container">
        <ResponsiveContainer width="100%" height="100%">
          {renderChart(type, data, resolvedXKey, resolvedYKeys, resolvedColors)}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

const renderChart = (
  type: ChartData['type'],
  data: Record<string, unknown>[],
  xKey: string,
  yKeys: string[],
  colors: string[],
) => {
  const commonProps = { data, margin: { top: 8, right: 16, bottom: 8, left: 0 } }

  switch (type) {
    case 'bar':
      return (
        <BarChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-weak)" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} stroke="var(--text-weaker)" />
          <YAxis tick={{ fontSize: 11 }} stroke="var(--text-weaker)" />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend />
          {yKeys.map((key, i) => (
            <Bar key={key} dataKey={key} fill={colors[i % colors.length]} radius={[3, 3, 0, 0]} />
          ))}
        </BarChart>
      )
    case 'line':
      return (
        <LineChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-weak)" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} stroke="var(--text-weaker)" />
          <YAxis tick={{ fontSize: 11 }} stroke="var(--text-weaker)" />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend />
          {yKeys.map((key, i) => (
            <Line key={key} type="monotone" dataKey={key} stroke={colors[i % colors.length]} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      )
    case 'area':
      return (
        <AreaChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-weak)" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} stroke="var(--text-weaker)" />
          <YAxis tick={{ fontSize: 11 }} stroke="var(--text-weaker)" />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend />
          {yKeys.map((key, i) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={colors[i % colors.length]}
              fill={colors[i % colors.length]}
              fillOpacity={0.15}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      )
    case 'scatter':
      return (
        <ScatterChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-weak)" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} stroke="var(--text-weaker)" name={xKey} />
          <YAxis dataKey={yKeys[0]} tick={{ fontSize: 11 }} stroke="var(--text-weaker)" name={yKeys[0]} />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend />
          <Scatter name={yKeys[0] ?? 'data'} data={data} fill={colors[0]} />
        </ScatterChart>
      )
    case 'pie':
      return (
        <PieChart>
          <Pie
            data={data}
            dataKey={yKeys[0] ?? 'value'}
            nameKey={xKey}
            cx="50%"
            cy="50%"
            outerRadius="70%"
            label={({ name, percent }: { name: string; percent: number }) =>
              `${name} ${(percent * 100).toFixed(0)}%`
            }
            labelLine={false}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} />
          <Legend />
        </PieChart>
      )
  }
}

const tooltipStyle: React.CSSProperties = {
  background: 'var(--surface-inset)',
  border: '1px solid var(--border-weak)',
  borderRadius: '6px',
  fontSize: '12px',
  color: 'var(--text-strong)',
}

registerCanvas('chart', ChartRenderer)

export default ChartRenderer
