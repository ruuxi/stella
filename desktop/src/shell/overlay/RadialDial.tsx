import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from 'react'
import { Camera, MessageSquare, Mic, X } from 'lucide-react'
import { StellaAnimation } from '@/shell/ascii-creature/StellaAnimation'
import { cssToVec3 } from '@/shared/lib/color'
import { RADIAL_SIZE } from '@/shared/lib/layout'
import { getElectronApi } from '@/platform/electron/electron'
import { useTheme } from '@/context/theme-context'
import type { RadialWedge } from '@/shared/types/electron'
import {
  cancelAnimation,
  destroyBlob,
  initBlob,
  primeBlob,
  startClose,
  startOpen,
  type BlobColors,
} from './radial-blob'

const BASE_WEDGES: {
  id: RadialWedge
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>> | null
}[] = [
  { id: 'capture', label: 'Capture', icon: Camera },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'close', label: 'Close', icon: X },
  { id: 'voice', label: 'Voice', icon: Mic },
]

const SIZE = RADIAL_SIZE
const CENTER = SIZE / 2
const INNER_RADIUS = 40
const OUTER_RADIUS = 125
const WEDGE_ANGLE = 90
const DEAD_ZONE_RADIUS = 30
const CENTER_BG_RADIUS = INNER_RADIUS - 5

const getWedges = (miniVisible: boolean) =>
  BASE_WEDGES.map((wedge) => ({
    ...wedge,
    enabled: wedge.id === 'close' ? miniVisible : true,
  }))

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

const calculateWedge = (
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  wedges: ReturnType<typeof getWedges>,
): RadialWedge => {
  const dx = x - centerX
  const dy = y - centerY
  const distance = Math.sqrt(dx * dx + dy * dy)

  if (distance < DEAD_ZONE_RADIUS) return 'dismiss'

  let angle = Math.atan2(dy, dx) * (180 / Math.PI)
  if (angle < 0) angle += 360
  angle = (angle + 90) % 360

  const wedgeIndex = Math.floor(angle / WEDGE_ANGLE)
  return wedges[wedgeIndex]?.enabled ? wedges[wedgeIndex].id : 'dismiss'
}

type Phase = 'hidden' | 'opening' | 'open' | 'closing'

type BlobRefs = {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  blobReady: React.RefObject<boolean>
  selectedIdxRef: React.RefObject<number>
  colorsRef: React.RefObject<BlobColors>
}

function getBlobColors(
  background: string,
  border: string,
  card: string,
  interactive: string,
  selectedIdx: number,
): BlobColors {
  const cardVec = cssToVec3(card)
  const interactiveVec = cssToVec3(interactive)

  return {
    fills: BASE_WEDGES.map((_, i) => (i === selectedIdx ? interactiveVec : cardVec)),
    selectedFill: interactiveVec,
    centerBg: cssToVec3(background),
    stroke: cssToVec3(border),
  }
}

function useRadialBlob(
  colors: ReturnType<typeof useTheme>['colors'],
  selectedIdx: number,
): BlobRefs {
  const { background, border, card, interactive } = colors
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const blobReady = useRef(false)
  const selectedIdxRef = useRef(selectedIdx)
  const colorsRef = useRef<BlobColors>(
    getBlobColors(background, border, card, interactive, selectedIdx),
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas && !blobReady.current) {
      const dpr = window.devicePixelRatio || 1
      canvas.width = SIZE * dpr
      canvas.height = SIZE * dpr
      blobReady.current = initBlob(canvas)
      if (blobReady.current) {
        // Warm a hidden frame so the first visible open does not stall on the
        // initial WebGL pipeline work.
        primeBlob(colorsRef.current)
      }
    }
    return () => {
      destroyBlob()
      blobReady.current = false
    }
  }, [])

  useEffect(() => {
    selectedIdxRef.current = selectedIdx
    colorsRef.current = getBlobColors(background, border, card, interactive, selectedIdx)
  }, [background, border, card, interactive, selectedIdx])

  return useMemo(() => ({ canvasRef, blobReady, selectedIdxRef, colorsRef }), [])
}

function useRadialIPC(
  blob: BlobRefs,
  wedges: ReturnType<typeof getWedges>,
  setSelectedWedge: React.Dispatch<React.SetStateAction<RadialWedge>>,
  setPhase: React.Dispatch<React.SetStateAction<Phase>>,
  setContentVisible: React.Dispatch<React.SetStateAction<boolean>>,
) {
  const visibleRef = useRef(false)
  const phaseRef = useRef<Phase>('hidden')
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transitionIdRef = useRef(0)
  const wedgesRef = useRef(wedges)

  useEffect(() => {
    wedgesRef.current = wedges
  }, [wedges])

  useEffect(() => {
    if (!getElectronApi()) return

    const handleShow = (
      _event: unknown,
      data: { centerX: number; centerY: number; x?: number; y?: number },
    ) => {
      const transitionId = ++transitionIdRef.current
      visibleRef.current = true

      if (typeof data.x === 'number' && typeof data.y === 'number') {
        setSelectedWedge(
          calculateWedge(data.x, data.y, data.centerX, data.centerY, wedgesRef.current),
        )
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
            if (!visibleRef.current || transitionIdRef.current !== transitionId) return
            phaseRef.current = 'open'
            setPhase('open')
            setContentVisible(true)
          },
          () => {
            if (!visibleRef.current || transitionIdRef.current !== transitionId) return
            setContentVisible(true)
          },
        )
      } else {
        setPhase('open')
        phaseRef.current = 'open'
        requestAnimationFrame(() => {
          if (!visibleRef.current || transitionIdRef.current !== transitionId) return
          setContentVisible(true)
        })
      }
    }

    const handleHide = () => {
      const transitionId = ++transitionIdRef.current
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
          if (transitionIdRef.current !== transitionId) return
          contentTimerRef.current = null
          setContentVisible(false)
        }, 60)
        startClose(blob.selectedIdxRef, blob.colorsRef, () => {
          if (transitionIdRef.current !== transitionId) return
          visibleRef.current = false
          setPhase('hidden')
          phaseRef.current = 'hidden'
          setContentVisible(false)
          requestAnimationFrame(() => {
            if (transitionIdRef.current === transitionId && !visibleRef.current) {
              window.electronAPI?.radial.animDone?.()
            }
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
      const wedge = calculateWedge(
        data.x,
        data.y,
        data.centerX,
        data.centerY,
        wedgesRef.current,
      )
      setSelectedWedge((prev) => (prev === wedge ? prev : wedge))
    }

    const electronAPI = window.electronAPI
    if (electronAPI?.radial.onShow) {
      const cleanupShow = electronAPI.radial.onShow(handleShow)
      const cleanupHide = electronAPI.radial.onHide(handleHide)
      const cleanupCursor = electronAPI.radial.onCursor(handleCursor)

      return () => {
        transitionIdRef.current += 1
        visibleRef.current = false
        cancelAnimation()
        if (contentTimerRef.current) clearTimeout(contentTimerRef.current)
        cleanupShow()
        cleanupHide()
        cleanupCursor()
      }
    }
  }, [blob, setSelectedWedge, setPhase, setContentVisible])
}

export function RadialDial({ miniVisible = false }: { miniVisible?: boolean }) {
  const [selectedWedge, setSelectedWedge] = useState<RadialWedge>('dismiss')
  const [phase, setPhase] = useState<Phase>('hidden')
  const [contentVisible, setContentVisible] = useState(false)
  const { colors } = useTheme()
  const wedges = useMemo(() => getWedges(miniVisible), [miniVisible])
  const wedgeLayout = useMemo(
    () => wedges.map((wedge, index) => ({
      ...wedge,
      contentPos: getContentPosition(index),
      path: createWedgePath(index * WEDGE_ANGLE, (index + 1) * WEDGE_ANGLE),
    })),
    [wedges],
  )

  const selectedBlobIndex = useMemo(
    () =>
      phase === 'open' || phase === 'closing'
        ? wedges.findIndex((w) => w.id === selectedWedge)
        : -1,
    [phase, selectedWedge, wedges],
  )
  const blob = useRadialBlob(colors, selectedBlobIndex)
  useRadialIPC(blob, wedges, setSelectedWedge, setPhase, setContentVisible)
  const { canvasRef } = blob
  const palette = useMemo(() => {
    const interactive = toRgba(colors.interactive, 1)
    const interactiveStroke = toRgba(colors.interactive, 0.9)
    const card = toRgba(colors.card, 1)
    const border = toRgba(colors.border, 0.5)
    const background = toRgba(colors.background, 1)
    return {
      interactive,
      interactiveStroke,
      card,
      border,
      background,
    }
  }, [colors.background, colors.border, colors.card, colors.interactive])

  const showCanvas = phase !== 'hidden'

  return (
    <div className="radial-dial-container">
      <canvas
        ref={canvasRef}
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
          {wedgeLayout.map((wedge) => {
            const isSelected = selectedWedge === wedge.id
            const treatAsEnabled = wedge.enabled || phase === 'closing'
            const fillColor = treatAsEnabled
              ? (isSelected ? palette.interactive : palette.card)
              : toRgba(colors.card, 0.5)
            const strokeColor = treatAsEnabled
              ? (isSelected ? palette.interactiveStroke : palette.border)
              : toRgba(colors.border, 0.3)

            return (
              <g key={wedge.id}>
                <path
                  d={wedge.path}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={1.5}
                  className="wedge-path"
                  style={{
                    transition: 'fill 0.15s ease, stroke 0.15s ease',
                    cursor: 'pointer',
                  }}
                />
              </g>
            )
          })}

          <circle
            cx={CENTER}
            cy={CENTER}
            r={CENTER_BG_RADIUS}
            fill={palette.background}
            stroke={palette.border}
            strokeWidth={1}
            style={{ transition: 'fill 0.15s ease, stroke 0.15s ease' }}
          />
        </svg>

        {wedgeLayout.map((wedge) => {
          const Icon = wedge.icon
          const isSelected = selectedWedge === wedge.id
          const treatIconEnabled = wedge.enabled || phase === 'closing'
          const iconColor = treatIconEnabled
            ? (isSelected ? colors.primaryForeground : colors.mutedForeground)
            : toRgba(colors.mutedForeground, 0.45)

          return (
            <div
              key={`${wedge.id}-content`}
              className="radial-wedge-content"
              style={{
                left: wedge.contentPos.x,
                top: wedge.contentPos.y,
                color: iconColor,
              }}
            >
              {Icon ? (
                <Icon
                  aria-hidden="true"
                  width={16}
                  height={16}
                  style={{ transition: 'color 0.1s' }}
                />
              ) : null}
              {wedge.label ? (
                <span
                  className="radial-wedge-label"
                  style={{ transition: 'color 0.1s' }}
                >
                  {wedge.label}
                </span>
              ) : null}
            </div>
          )
        })}

        <div className="radial-center-stella-animation">
          <StellaAnimation width={20} height={20} initialBirthProgress={1} maxDpr={1} frameSkip={1} />
        </div>
      </div>
    </div>
  )
}
