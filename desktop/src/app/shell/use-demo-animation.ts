import { useCallback, useRef, useState } from 'react'
import type { OnboardingDemo } from '@/app/onboarding/OnboardingCanvas'

export function useDemoAnimation() {
  const [activeDemo, setActiveDemo] = useState<OnboardingDemo>(null)
  const [demoClosing, setDemoClosing] = useState(false)
  const demoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleDemoChange = useCallback((demo: OnboardingDemo) => {
    if (demo) {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current)
        demoCloseTimerRef.current = null
      }

      setDemoClosing(false)
      setActiveDemo(demo)
      return
    }

    setActiveDemo(null)
    setDemoClosing(true)
    demoCloseTimerRef.current = setTimeout(() => {
      setDemoClosing(false)
      demoCloseTimerRef.current = null
    }, 400)
  }, [])

  return { activeDemo, demoClosing, handleDemoChange }
}
