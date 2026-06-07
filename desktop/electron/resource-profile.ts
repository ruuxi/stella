import os from 'os'

const LOW_MEMORY_WINDOWS_TOTAL_BYTES = 8 * 1024 * 1024 * 1024

const readBooleanOverride = (value: string | undefined): boolean | null => {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

export const getTotalSystemMemoryMb = (): number =>
  Math.round(os.totalmem() / 1024 / 1024)

export const isLowMemoryWindowsDevice = (): boolean => {
  const override = readBooleanOverride(process.env.STELLA_LOW_MEMORY_WINDOWS)
  if (override !== null) return override
  return (
    process.platform === 'win32' &&
    os.totalmem() <= LOW_MEMORY_WINDOWS_TOTAL_BYTES
  )
}
