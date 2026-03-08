import { useState } from 'react'
import type { DialogType } from './types'

export function useDialogManager() {
  const [activeDialog, setActiveDialog] = useState<DialogType>(null)
  return { activeDialog, setActiveDialog }
}
