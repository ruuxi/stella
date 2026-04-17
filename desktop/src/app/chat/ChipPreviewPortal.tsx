import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"

/**
 * Hover/focus preview that escapes any clipping ancestor (e.g. the composer
 * shell's `overflow: clip`). The trigger and the preview body are rendered
 * separately: the trigger lives where the chip lives, and the preview is
 * portaled to `document.body` and positioned via `getBoundingClientRect`.
 *
 * Caller supplies the trigger element (as a ref) and the preview content;
 * this component handles position math, scroll/resize repositioning, and
 * the fade transition.
 *
 * The hover/focus listener glue lives in `use-hover-preview.ts` so this file
 * can stick to component exports (Vite fast-refresh rule).
 */

type Placement = "top" | "bottom"

type ChipPreviewPortalProps = {
  /** The element the preview anchors above/below. */
  triggerRef: RefObject<HTMLElement | null>
  /** When false the preview is hidden (no DOM at all). */
  open: boolean
  /** Pixels of gap between the trigger and the preview. */
  gap?: number
  /** Force placement; defaults to "top" with auto-flip to "bottom". */
  preferredPlacement?: Placement
  /** Visual className for the preview shell — caller controls styling. */
  className?: string
  children: ReactNode
}

const DEFAULT_GAP = 8
const VIEWPORT_PADDING = 12

type Position = {
  top: number
  left: number
  placement: Placement
  measured: boolean
}

const HIDDEN_POSITION: Position = {
  top: -9999,
  left: -9999,
  placement: "top",
  measured: false,
}

export function ChipPreviewPortal({
  triggerRef,
  open,
  gap = DEFAULT_GAP,
  preferredPlacement = "top",
  className,
  children,
}: ChipPreviewPortalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // We always render the portal box while `open` is true and let the
  // position state decide what's visible. Default to off-screen so the
  // first paint can measure without flashing in the wrong spot.
  const [position, setPosition] = useState<Position>(HIDDEN_POSITION)

  const reposition = useCallback(() => {
    const trigger = triggerRef.current
    const container = containerRef.current
    if (!trigger || !container) return

    const triggerRect = trigger.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const containerWidth = containerRect.width || container.offsetWidth
    const containerHeight = containerRect.height || container.offsetHeight

    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    const spaceAbove = triggerRect.top
    const spaceBelow = viewportHeight - triggerRect.bottom

    const fitsAbove = spaceAbove >= containerHeight + gap + VIEWPORT_PADDING
    const fitsBelow = spaceBelow >= containerHeight + gap + VIEWPORT_PADDING

    let placement: Placement = preferredPlacement
    if (placement === "top" && !fitsAbove && fitsBelow) placement = "bottom"
    if (placement === "bottom" && !fitsBelow && fitsAbove) placement = "top"

    const top =
      placement === "top"
        ? Math.max(VIEWPORT_PADDING, triggerRect.top - containerHeight - gap)
        : Math.min(
            viewportHeight - containerHeight - VIEWPORT_PADDING,
            triggerRect.bottom + gap,
          )

    const desiredLeft = triggerRect.left
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      viewportWidth - containerWidth - VIEWPORT_PADDING,
    )
    const left = Math.min(maxLeft, Math.max(VIEWPORT_PADDING, desiredLeft))

    setPosition({ top, left, placement, measured: true })
  }, [gap, preferredPlacement, triggerRef])

  useLayoutEffect(() => {
    if (!open) return undefined
    // Wait one frame so the container has measurable dimensions, then
    // reposition. The portal box is mounted at off-screen coordinates
    // until then so layout never flashes in the wrong spot.
    const raf = window.requestAnimationFrame(() => reposition())
    return () => window.cancelAnimationFrame(raf)
  }, [open, reposition])

  useEffect(() => {
    if (!open) return undefined
    const handle = () => reposition()
    window.addEventListener("scroll", handle, true)
    window.addEventListener("resize", handle)
    return () => {
      window.removeEventListener("scroll", handle, true)
      window.removeEventListener("resize", handle)
    }
  }, [open, reposition])

  if (!open) return null

  return createPortal(
    <div
      ref={containerRef}
      className={className}
      role="tooltip"
      style={{
        position: "fixed",
        top: `${position.top}px`,
        left: `${position.left}px`,
        zIndex: 9000,
        opacity: position.measured ? 1 : 0,
        transform: position.measured
          ? "translateY(0)"
          : position.placement === "top"
            ? "translateY(4px)"
            : "translateY(-4px)",
        transition: "opacity 140ms ease, transform 140ms ease",
        pointerEvents: "none",
      }}
      data-placement={position.placement}
    >
      {children}
    </div>,
    document.body,
  )
}
