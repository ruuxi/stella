import { useEffect, useRef, useState } from "react"

/**
 * Hover/focus listeners for a chip preview. Returns a ref to attach to the
 * trigger element and the current `open` flag. Lives in its own module so
 * `ChipPreviewPortal.tsx` only exports components (Vite fast-refresh rule).
 */
export function useHoverPreview<T extends HTMLElement>() {
  const triggerRef = useRef<T | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const trigger = triggerRef.current
    if (!trigger) return undefined

    const onEnter = () => setOpen(true)
    const onLeave = () => setOpen(false)

    trigger.addEventListener("mouseenter", onEnter)
    trigger.addEventListener("mouseleave", onLeave)
    trigger.addEventListener("focus", onEnter)
    trigger.addEventListener("blur", onLeave)
    return () => {
      trigger.removeEventListener("mouseenter", onEnter)
      trigger.removeEventListener("mouseleave", onLeave)
      trigger.removeEventListener("focus", onEnter)
      trigger.removeEventListener("blur", onLeave)
    }
  }, [])

  return { triggerRef, open }
}
