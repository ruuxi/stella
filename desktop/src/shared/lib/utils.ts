import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Extract port from a localhost URL, or null if not localhost. */
export const getLocalhostPort = (url?: string): number | null => {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const port = parseInt(parsed.port, 10)
      return Number.isFinite(port) ? port : null
    }
  } catch { /* invalid URL */ }
  return null
}
