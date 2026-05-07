/**
 * Buttery rAF-driven scroll tween. We roll our own instead of relying on
 * the browser's `behavior: 'smooth'` because the native version is
 * single-shot and can't be re-targeted mid-flight — every new chunk of
 * streamed text would cancel/restart the animation and look choppy.
 *
 * `smoothScrollBy` chains gracefully: a second call while a tween is
 * running picks up from the current scrollTop and re-tweens to the new
 * absolute target, so successive nudges blend into one motion.
 */

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

type ActiveTween = {
  rafId: number
  target: number
}

const activeTweens = new WeakMap<HTMLElement, ActiveTween>()

export function cancelSmoothScroll(el: HTMLElement): void {
  const tween = activeTweens.get(el)
  if (tween) {
    cancelAnimationFrame(tween.rafId)
    activeTweens.delete(el)
  }
}

export function smoothScrollTo(
  el: HTMLElement,
  target: number,
  durationMs = 320,
): void {
  const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
  const clampedTarget = Math.max(0, Math.min(maxScroll, target))
  const start = el.scrollTop
  const distance = clampedTarget - start
  if (Math.abs(distance) < 0.5 || durationMs <= 0) {
    cancelSmoothScroll(el)
    el.scrollTop = clampedTarget
    return
  }

  cancelSmoothScroll(el)
  const startTime = performance.now()

  const step = () => {
    const now = performance.now()
    const t = Math.min(1, (now - startTime) / durationMs)
    el.scrollTop = start + distance * easeOutCubic(t)
    if (t < 1) {
      const tween = activeTweens.get(el)
      if (!tween) return
      tween.rafId = requestAnimationFrame(step)
    } else {
      activeTweens.delete(el)
    }
  }

  const rafId = requestAnimationFrame(step)
  activeTweens.set(el, { rafId, target: clampedTarget })
}

export function smoothScrollBy(
  el: HTMLElement,
  delta: number,
  durationMs = 320,
): void {
  const existing = activeTweens.get(el)
  const base = existing ? existing.target : el.scrollTop
  smoothScrollTo(el, base + delta, durationMs)
}
