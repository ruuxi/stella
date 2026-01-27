import { useEffect, useState, useCallback } from 'react'
import { MessageSquare, Mic, Maximize2, Menu, Search } from 'lucide-react'
import { getElectronApi } from '../services/electron'
import type { RadialWedge } from '../types/electron'

const WEDGES: { id: RadialWedge; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'ask', label: 'Ask', icon: Search },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'full', label: 'Full', icon: Maximize2 },
  { id: 'menu', label: 'Menu', icon: Menu },
]

const SIZE = 280
const CENTER = SIZE / 2
const INNER_RADIUS = 40
const OUTER_RADIUS = 125
const WEDGE_ANGLE = 72 // 360 / 5 wedges
const DEAD_ZONE_RADIUS = 15 // Small dead zone

// Generate SVG path for a wedge
const createWedgePath = (startAngle: number, endAngle: number): string => {
  const startRad = (startAngle - 90) * (Math.PI / 180)
  const endRad = (endAngle - 90) * (Math.PI / 180)

  const x1 = CENTER + INNER_RADIUS * Math.cos(startRad)
  const y1 = CENTER + INNER_RADIUS * Math.sin(startRad)
  const x2 = CENTER + OUTER_RADIUS * Math.cos(startRad)
  const y2 = CENTER + OUTER_RADIUS * Math.sin(startRad)
  const x3 = CENTER + OUTER_RADIUS * Math.cos(endRad)
  const y3 = CENTER + OUTER_RADIUS * Math.sin(endRad)
  const x4 = CENTER + INNER_RADIUS * Math.cos(endRad)
  const y4 = CENTER + INNER_RADIUS * Math.sin(endRad)

  return `
    M ${x1} ${y1}
    L ${x2} ${y2}
    A ${OUTER_RADIUS} ${OUTER_RADIUS} 0 0 1 ${x3} ${y3}
    L ${x4} ${y4}
    A ${INNER_RADIUS} ${INNER_RADIUS} 0 0 0 ${x1} ${y1}
    Z
  `
}

// Get icon + label position for a wedge
const getContentPosition = (index: number) => {
  const midAngle = (index * WEDGE_ANGLE + WEDGE_ANGLE / 2 - 90) * (Math.PI / 180)
  const contentRadius = (INNER_RADIUS + OUTER_RADIUS) / 2
  return {
    x: CENTER + contentRadius * Math.cos(midAngle),
    y: CENTER + contentRadius * Math.sin(midAngle),
  }
}

export function RadialDial() {
  const [visible, setVisible] = useState(false)
  const [selectedWedge, setSelectedWedge] = useState<RadialWedge | null>(null)
  const api = getElectronApi()

  const calculateWedge = useCallback(
    (x: number, y: number, centerX: number, centerY: number): RadialWedge | null => {
      const dx = x - centerX
      const dy = y - centerY
      const distance = Math.sqrt(dx * dx + dy * dy)

      // Small dead zone in center - no outer limit so dragging far still works
      if (distance < DEAD_ZONE_RADIUS) {
        return null
      }

      // Calculate angle (0 = right, going clockwise)
      let angle = Math.atan2(dy, dx) * (180 / Math.PI)
      // Normalize to 0-360
      if (angle < 0) angle += 360

      // Adjust angle to start from top
      angle = (angle + 90) % 360

      // Determine wedge index
      const wedgeIndex = Math.floor(angle / WEDGE_ANGLE)
      return WEDGES[wedgeIndex]?.id ?? null
    },
    []
  )

  useEffect(() => {
    if (!api) return

    // Listen for radial events from main process
    const handleShow = (_event: unknown, _data: { centerX: number; centerY: number }) => {
      setVisible(true)
      setSelectedWedge(null)
    }

    const handleHide = () => {
      setVisible(false)
      setSelectedWedge(null)
    }

    const handleCursor = (
      _event: unknown,
      data: { x: number; y: number; centerX: number; centerY: number }
    ) => {
      const wedge = calculateWedge(data.x, data.y, data.centerX, data.centerY)
      setSelectedWedge(wedge)
    }

    // Access ipcRenderer through electronAPI
    const electronAPI = window.electronAPI
    if (electronAPI?.onRadialShow) {
      const cleanupShow = electronAPI.onRadialShow(handleShow)
      const cleanupHide = electronAPI.onRadialHide(handleHide)
      const cleanupCursor = electronAPI.onRadialCursor(handleCursor)

      return () => {
        cleanupShow()
        cleanupHide()
        cleanupCursor()
      }
    }
  }, [api, calculateWedge])

  // Also listen for wedge selection on mouse up
  useEffect(() => {
    if (!api) return

    const electronAPI = window.electronAPI

    const handleMouseUp = (_event: unknown, data: { wedge: RadialWedge | null }) => {
      if (data.wedge && visible) {
        electronAPI?.radialSelect(data.wedge)
      }
    }

    if (electronAPI?.onRadialMouseUp) {
      const cleanup = electronAPI.onRadialMouseUp(handleMouseUp)
      return cleanup
    }
  }, [api, visible, selectedWedge])

  // Send selection when mouse is released while radial is visible
  useEffect(() => {
    if (!visible) return

    const electronAPI = window.electronAPI

    const handleGlobalMouseUp = () => {
      if (selectedWedge && electronAPI?.radialSelect) {
        electronAPI.radialSelect(selectedWedge)
      }
    }

    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp)
  }, [visible, selectedWedge])

  if (!visible) {
    return <div className="radial-dial-container" />
  }

  return (
    <div className="radial-dial-container">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="radial-dial"
      >
        {/* Background blur circle */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={OUTER_RADIUS + 10}
          fill="rgba(0, 0, 0, 0.7)"
        />

        {/* Wedges */}
        {WEDGES.map((wedge, index) => {
          const startAngle = index * WEDGE_ANGLE
          const endAngle = (index + 1) * WEDGE_ANGLE
          const isSelected = selectedWedge === wedge.id
          const contentPos = getContentPosition(index)
          const Icon = wedge.icon

          return (
            <g key={wedge.id}>
              <path
                d={createWedgePath(startAngle, endAngle)}
                fill={isSelected ? 'rgba(59, 130, 246, 0.9)' : 'rgba(40, 40, 40, 0.9)'}
                stroke={isSelected ? '#60a5fa' : 'rgba(255, 255, 255, 0.12)'}
                strokeWidth={1.5}
                className="wedge-path"
                style={{
                  transition: 'fill 0.1s ease, stroke 0.1s ease',
                }}
              />
              <foreignObject
                x={contentPos.x - 28}
                y={contentPos.y - 20}
                width={56}
                height={40}
                style={{ pointerEvents: 'none' }}
              >
                <div className="flex flex-col items-center justify-center w-full h-full gap-0.5">
                  <Icon
                    className={`w-4 h-4 transition-colors duration-100 ${isSelected ? 'text-white' : 'text-gray-300'}`}
                  />
                  <span
                    className={`text-[10px] font-medium transition-colors duration-100 ${isSelected ? 'text-white' : 'text-gray-400'}`}
                  >
                    {wedge.label}
                  </span>
                </div>
              </foreignObject>
            </g>
          )
        })}

        {/* Center circle */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={INNER_RADIUS - 5}
          fill="rgba(25, 25, 25, 0.95)"
          stroke="rgba(255, 255, 255, 0.15)"
          strokeWidth={1}
        />

        {/* Stellar logo/text in center */}
        <text
          x={CENTER}
          y={CENTER + 4}
          textAnchor="middle"
          fill="rgba(255, 255, 255, 0.5)"
          fontSize={10}
          fontWeight={500}
          className="select-none"
        >
          ✦
        </text>
      </svg>
    </div>
  )
}
