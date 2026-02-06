import { useEffect, useState, useCallback, useRef, type ComponentType, type SVGProps } from 'react'
import { Camera, MessageSquare, Mic, Maximize2, Sparkles } from 'lucide-react'
import { getElectronApi } from '../services/electron'
import type { RadialWedge } from '../types/electron'
import { useTheme } from '../theme/theme-context'
import { hexToRgb } from '../theme/color'
import { AsciiBlackHole } from '../components/AsciiBlackHole'

const WEDGES: { id: RadialWedge; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: 'capture', label: 'Capture', icon: Camera },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'full', label: 'Full', icon: Maximize2 },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'auto', label: 'Auto', icon: Sparkles },
]

const SIZE = 280
const CENTER = SIZE / 2
const INNER_RADIUS = 40
const OUTER_RADIUS = 125
const WEDGE_ANGLE = 72 // 360 / 5 wedges
const DEAD_ZONE_RADIUS = 30 // Center zone for "dismiss"
const CENTER_BG_RADIUS = INNER_RADIUS - 5

// Helper to convert hex to rgba with alpha
const toRgba = (color: string, alpha: number): string => {
  if (color.startsWith('#')) {
    const { r, g, b } = hexToRgb(color)
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`
  }
  return color
}

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
  const [selectedWedge, setSelectedWedge] = useState<RadialWedge>('dismiss')
  const [animateIn, setAnimateIn] = useState(false)
  const visibleRef = useRef(false)
  const api = getElectronApi()
  const { colors } = useTheme()

  const calculateWedge = useCallback(
    (x: number, y: number, centerX: number, centerY: number): RadialWedge => {
      const dx = x - centerX
      const dy = y - centerY
      const distance = Math.sqrt(dx * dx + dy * dy)

      // Center zone = dismiss
      if (distance < DEAD_ZONE_RADIUS) {
        return 'dismiss'
      }

      // Calculate angle (0 = right, going clockwise)
      let angle = Math.atan2(dy, dx) * (180 / Math.PI)
      // Normalize to 0-360
      if (angle < 0) angle += 360

      // Adjust angle to start from top
      angle = (angle + 90) % 360

      // Determine wedge index
      const wedgeIndex = Math.floor(angle / WEDGE_ANGLE)
      return WEDGES[wedgeIndex]?.id ?? 'dismiss'
    },
    []
  )

  useEffect(() => {
    if (!api) return

    // Listen for radial events from main process
    const handleShow = (
      _event: unknown,
      data: { centerX: number; centerY: number; x?: number; y?: number }
    ) => {
      visibleRef.current = true
      if (typeof data.x === 'number' && typeof data.y === 'number') {
        const wedge = calculateWedge(data.x, data.y, data.centerX, data.centerY)
        setSelectedWedge(wedge)
      } else {
        setSelectedWedge('dismiss')
      }
      // Trigger entrance animation directly — uses CSS @keyframes (not transitions),
      // so it carries its own "from" state and doesn't need a pre-committed frame.
      setAnimateIn(true)
    }

    const handleHide = () => {
      visibleRef.current = false
      setSelectedWedge('dismiss')
      // Reset immediately — the window is parked off-screen so the user won't
      // see this. Next show will start from the base state.
      setAnimateIn(false)
    }

    const handleCursor = (
      _event: unknown,
      data: { x: number; y: number; centerX: number; centerY: number }
    ) => {
      if (!visibleRef.current) return
      const wedge = calculateWedge(data.x, data.y, data.centerX, data.centerY)
      setSelectedWedge((prev) => (prev === wedge ? prev : wedge))
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

  // Always render the full SVG so the compositor buffer is pre-painted.
  // Window visibility is controlled by OS show()/hide() in the main process.
  return (
    <div className="radial-dial-container">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={`radial-dial${animateIn ? ' radial-dial--visible' : ''}`}
        style={{}}
      >
        {/* Wedges */}
        {WEDGES.map((wedge, index) => {
          const startAngle = index * WEDGE_ANGLE
          const endAngle = (index + 1) * WEDGE_ANGLE
          const isSelected = selectedWedge === wedge.id
          const contentPos = getContentPosition(index)
          const Icon = wedge.icon
          
          const fillColor = isSelected 
            ? toRgba(colors.interactive, 0.9) 
            : colors.card // Card often has transparency
          
          const strokeColor = isSelected
            ? colors.interactive
            : toRgba(colors.border, 0.2)
            
          const iconColor = isSelected 
            ? colors.primaryForeground 
            : colors.mutedForeground

          return (
            <g key={wedge.id}>
              <path
                d={createWedgePath(startAngle, endAngle)}
                fill={fillColor}
                stroke={strokeColor}
                strokeWidth={1.5}
                className="wedge-path"
                style={{
                  transition: 'fill 0.15s ease, stroke 0.15s ease',
                  cursor: 'pointer'
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
                    style={{ 
                      color: iconColor,
                      width: '16px',
                      height: '16px',
                      transition: 'color 0.1s'
                    }}
                  />
                  <span
                    style={{ 
                      color: iconColor,
                      fontSize: '10px',
                      fontWeight: 500,
                      transition: 'color 0.1s'
                    }}
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
          r={CENTER_BG_RADIUS}
          fill={toRgba(colors.background, 0.95)}
          stroke={toRgba(colors.border, 0.5)}
          strokeWidth={1}
          style={{ transition: 'fill 0.15s ease, stroke 0.15s ease' }}
        />
      </svg>

      {/* Center blackhole animation - outside SVG for WebGL compatibility */}
      <div className="radial-center-blackhole">
        <AsciiBlackHole width={20} height={20} initialBirthProgress={1} />
      </div>
    </div>
  )
}
