export function getPlatform(): string {
  return window.electronAPI?.platform ?? "unknown";
}
