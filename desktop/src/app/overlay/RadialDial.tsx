import {
  useEffect,
  useMemo,
  useState,
  useRef,
  type ComponentType,
  type SVGProps
} from 'react';
import { Camera, MessageSquare, Mic, Maximize2, Sparkles } from 'lucide-react'
import { RADIAL_SIZE } from '@/lib/layout'
import { getElectronApi } from '@/services/electron'
import type { RadialWedge } from '@/types/electron'
import { useTheme } from '@/theme/theme-context'
import { StellaAnimation } from '@/app/shell/ascii-creature/StellaAnimation'
import { cssToVec3 } from '@/lib/color'
import {
  initBlob,
  startOpen,
  startClose,
  cancelAnimation,
  destroyBlob,
  type BlobColors,
} from './radial-blob'

const WEDGES: { id: RadialWedge; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: 'capture', label: 'Capture', icon: Camera },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'full', label: 'Full', icon: Maximize2 },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'auto', label: 'Auto', icon: Sparkles },
]

const SIZE = RADIAL_SIZE
const CENTER = SIZE / 2
const INNER_RADIUS = 40
const OUTER_RADIUS = 125
const WEDGE_ANGLE = 72 // 360 / 5 wedges
const DEAD_ZONE_RADIUS = 30 // Center zone for "dismiss"
const CENTER_BG_RADIUS = INNER_RADIUS - 5

const toRgba = (color: string, alpha: number): string => {
  const [r, g, b] = cssToVec3(color)
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`
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

const calculateWedge = (x: number, y: number, centerX: number, centerY: number): RadialWedge => {
  const dx = x - centerX
  const dy = y - centerY
  const distance = Math.sqrt(dx * dx + dy * dy)

  if (distance < DEAD_ZONE_RADIUS) return 'dismiss'

  let angle = Math.atan2(dy, dx) * (180 / Math.PI)
  if (angle < 0) angle += 360
  angle = (angle + 90) % 360

  const wedgeIndex = Math.floor(angle / WEDGE_ANGLE)
  return WEDGES[wedgeIndex]?.id ?? 'dismiss'
}

type Phase = 'hidden' | 'opening' | 'open' | 'closing'

type BlobRefs = {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  blobReady: React.RefObject<boolean>
  selectedIdxRef: React.RefObject<number>
  colorsRef: React.RefObject<BlobColors>
}

/** Manages the WebGL blob lifecycle and theme color sync. */
function useRadialBlob(colors: ReturnType<typeof useTheme>['colors']): BlobRefs {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const blobReady = useRef(false)
  const selectedIdxRef = useRef(-1)
  const colorsRef = useRef<BlobColors>({
    fills: Array(5).fill([0.2, 0.2, 0.2] as [number, number, number]),
    selectedFill: [0.4, 0.4, 0.8],
    centerBg: [0.1, 0.1, 0.1],
    stroke: [0.3, 0.3, 0.3],
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas && !blobReady.current) {
      const dpr = window.devicePixelRatio || 1
      canvas.width = SIZE * dpr
      canvas.height = SIZE * dpr
      blobReady.current = initBlob(canvas)
    }
    return () => {
      destroyBlob()
      blobReady.current = false
    }
  }, [])

  useEffect(() => {
    const cardVec = cssToVec3(colors.card)
    colorsRef.current = {
      fills: Array(5).fill(cardVec),
      selectedFill: cssToVec3(colors.interactive),
      centerBg: cssToVec3(colors.background),
      stroke: cssToVec3(colors.border),
    }
  }, [colors])

  return useMemo(() => ({ canvasRef, blobReady, selectedIdxRef, colorsRef }), [])
}

/** Subscribes to radial IPC events (show/hide/cursor) and drives phase transitions. */
function useRadialIPC(
  blob: BlobRefs,
  setSelectedWedge: React.Dispatch<React.SetStateAction<RadialWedge>>,
  setPhase: React.Dispatch<React.SetStateAction<Phase>>,
  setContentVisible: React.Dispatch<React.SetStateAction<boolean>>,
) {
  const api = getElectronApi()
  const visibleRef = useRef(false)
  const phaseRef = useRef<Phase>('hidden')
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!api) return

    const handleShow = (
      _event: unknown,
      data: { centerX: number; centerY: number; x?: number; y?: number },
    ) => {
      visibleRef.current = true

      if (typeof data.x === 'number' && typeof data.y === 'number') {
        setSelectedWedge(calculateWedge(data.x, data.y, data.centerX, data.centerY))
      } else {
        setSelectedWedge('dismiss')
      }

      cancelAnimation()
      if (contentTimerRef.current) {
        clearTimeout(contentTimerRef.current)
        contentTimerRef.current = null
      }
      setContentVisible(false)

      if (blob.blobReady.current) {
        setPhase('opening')
        phaseRef.current = 'opening'

        startOpen(
          blob.selectedIdxRef,
          blob.colorsRef,
          () => {
            if (visibleRef.current) {
              setPhase('open')
              phaseRef.current = 'open'
              setContentVisible(true)
            }
          },
          () => {
            if (visibleRef.current) setContentVisible(true)
          },
        )
      } else {
        setPhase('open')
        phaseRef.current = 'open'
        requestAnimationFrame(() => {
          if (visibleRef.current) setContentVisible(true)
        })
      }
    }

    const handleHide = () => {
      if (contentTimerRef.current) {
        clearTimeout(contentTimerRef.current)
        contentTimerRef.current = null
      }
      setSelectedWedge('dismiss')
      blob.selectedIdxRef.current = -1

      if (blob.blobReady.current && phaseRef.current !== 'hidden') {
        setPhase('closing')
        phaseRef.current = 'closing'

        contentTimerRef.current = setTimeout(() => {
          contentTimerRef.current = null
          setContentVisible(false)
        }, 60)
        startClose(blob.selectedIdxRef, blob.colorsRef, () => {
          visibleRef.current = false
          setPhase('hidden')
          phaseRef.current = 'hidden'
          setContentVisible(false)
          requestAnimationFrame(() => {
            window.electronAPI?.radial.animDone?.()
          })
        })
      } else {
        cancelAnimation()
        setContentVisible(false)
        visibleRef.current = false
        setPhase('hidden')
        phaseRef.current = 'hidden'
      }
    }

    const handleCursor = (
      _event: unknown,
      data: { x: number; y: number; centerX: number; centerY: number },
    ) => {
      if (!visibleRef.current) return
      const wedge = calculateWedge(data.x, data.y, data.centerX, data.centerY)
      setSelectedWedge((prev) => (prev === wedge ? prev : wedge))
    }

    const electronAPI = window.electronAPI
    if (electronAPI?.radial.onShow) {
      const cleanupShow = electronAPI.radial.onShow(handleShow)
      const cleanupHide = electronAPI.radial.onHide(handleHide)
      const cleanupCursor = electronAPI.radial.onCursor(handleCursor)

      return () => {
        cancelAnimation()
        if (contentTimerRef.current) clearTimeout(contentTimerRef.current)
        cleanupShow()
        cleanupHide()
        cleanupCursor()
      }
    }
  }, [api, blob, setSelectedWedge, setPhase, setContentVisible])
}

export function RadialDial() {
  const [selectedWedge, setSelectedWedge] = useState<RadialWedge>('dismiss')
  const [phase, setPhase] = useState<Phase>('hidden')
  const [contentVisible, setContentVisible] = useState(false)
  const { colors } = useTheme()

  const blob = useRadialBlob(colors)
  useRadialIPC(blob, setSelectedWedge, setPhase, setContentVisible)

  // Sync selection highlight to blob colors — deferred until SVG is visible
  // because the asymmetric wobble during opening makes visual wedge positions
  // differ from mathematical boundaries.
  useEffect(() => {
    const idx = WEDGES.findIndex((w) => w.id === selectedWedge)
    blob.selectedIdxRef.current = phase === 'open' || phase === 'closing' ? idx : -1

    const cardVec = cssToVec3(colors.card)
    const selVec = cssToVec3(colors.interactive)
    blob.colorsRef.current = {
      ...blob.colorsRef.current,
      fills: WEDGES.map((_, i) => (i === idx ? selVec : cardVec)),
    }
  }, [selectedWedge, colors, phase, blob])

  // Canvas visible whenever the dial is not hidden to avoid compositor pops
  const showCanvas = phase !== 'hidden'

  return (
    <div className="radial-dial-container">
      <canvas
        ref={blob.canvasRef}
        className="radial-blob-canvas"
        style={{
          width: SIZE,
          height: SIZE,
          opacity: showCanvas ? 1 : 0,
          pointerEvents: 'none',
        }}
      />

      <div
        className={`radial-dial-frame${contentVisible ? ' radial-dial-frame--visible' : ''}`}
        style={{
          opacity: contentVisible ? 1 : 0,
          willChange: 'opacity, transform',
          transition: phase === 'closing'
            ? 'opacity 0.1s ease-in'
            : 'opacity 0.15s ease-out',
          pointerEvents: phase === 'hidden' ? 'none' : 'auto',
        }}
      >
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
              ? toRgba(colors.interactive, 1)
              : toRgba(colors.card, 1)

            const strokeColor = isSelected
              ? toRgba(colors.interactive, 0.9)
              : toRgba(colors.border, 0.5)

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
                    cursor: 'pointer',
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
                        transition: 'color 0.1s',
                      }}
                    />
                    <span
                      style={{
                        color: iconColor,
                        fontSize: '10px',
                        fontWeight: 500,
                        transition: 'color 0.1s',
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
            fill={toRgba(colors.background, 1)}
            stroke={toRgba(colors.border, 0.5)}
            strokeWidth={1}
            style={{ transition: 'fill 0.15s ease, stroke 0.15s ease' }}
          />
        </svg>

        <div className="radial-center-stella-animation">
          <StellaAnimation width={20} height={20} initialBirthProgress={1} maxDpr={1} frameSkip={1} />
        </div>
      </div>
    </div>
  )
}



