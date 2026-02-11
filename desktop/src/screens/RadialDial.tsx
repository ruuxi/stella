import { useEffect, useState, useCallback, useRef, type ComponentType, type SVGProps } from 'react'
import { Camera, MessageSquare, Mic, Maximize2, Sparkles } from 'lucide-react'
import { getElectronApi } from '../services/electron'
import type { RadialWedge } from '../types/electron'
import { useTheme } from '../theme/theme-context'
import { hexToRgb } from '../theme/color'
import { StellaAnimation } from '../components/StellaAnimation'

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

const toRgba = (color: string, alpha: number): string => {
  if (color.startsWith('#')) {
    const { r, g, b } = hexToRgb(color)
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`
  }
  return color
}

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
  const animateFrameRef = useRef<number | null>(null)
  const api = getElectronApi()
  const { colors } = useTheme()

  const calculateWedge = useCallback(
    (x: number, y: number, centerX: number, centerY: number): RadialWedge => {
      const dx = x - centerX
      const dy = y - centerY
      const distance = Math.sqrt(dx * dx + dy * dy)

      if (distance < DEAD_ZONE_RADIUS) {
        return 'dismiss'
      }

      let angle = Math.atan2(dy, dx) * (180 / Math.PI)
      if (angle < 0) angle += 360

      angle = (angle + 90) % 360

      const wedgeIndex = Math.floor(angle / WEDGE_ANGLE)
      return WEDGES[wedgeIndex]?.id ?? 'dismiss'
    },
    []
  )

  useEffect(() => {
    if (!api) return

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
      // Restart on the next frame so first-open paints don't skip the keyframe.
      if (animateFrameRef.current !== null) {
        cancelAnimationFrame(animateFrameRef.current)
      }
      setAnimateIn(false)
      animateFrameRef.current = requestAnimationFrame(() => {
        animateFrameRef.current = null
        if (!visibleRef.current) return
        setAnimateIn(true)
      })
    }

    const handleHide = () => {
      visibleRef.current = false
      setSelectedWedge('dismiss')
      if (animateFrameRef.current !== null) {
        cancelAnimationFrame(animateFrameRef.current)
        animateFrameRef.current = null
      }
      // Reset immediately; the window is parked off-screen, so users never see this.
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

    const electronAPI = window.electronAPI
    if (electronAPI?.onRadialShow) {
      const cleanupShow = electronAPI.onRadialShow(handleShow)
      const cleanupHide = electronAPI.onRadialHide(handleHide)
      const cleanupCursor = electronAPI.onRadialCursor(handleCursor)

      return () => {
        if (animateFrameRef.current !== null) {
          cancelAnimationFrame(animateFrameRef.current)
          animateFrameRef.current = null
        }
        cleanupShow()
        cleanupHide()
        cleanupCursor()
      }
    }
  }, [api, calculateWedge])

  return (
    <div className="radial-dial-container">
      <div className={`radial-dial-frame${animateIn ? ' radial-dial-frame--visible' : ''}`}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="radial-dial"
        >
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

        <div className="radial-center-stella-animation">
          <StellaAnimation width={20} height={20} initialBirthProgress={1} />
        </div>
      </div>
    </div>
  )
}
