export function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Pull a friendly blueprint name from the leading `# Heading` of the
 * markdown, falling back to "Blueprint" if there isn't one. Keeps the
 * pill's secondary line readable without inventing a separate field.
 */
export function deriveBlueprintName(text: string): string {
  const match = text.match(/^\s*#\s+(.+?)\s*$/m);
  if (match && match[1]) return match[1].trim();
  return "Blueprint";
}

export function fireBlueprintNotification(
  messageId: string,
  name: string,
): void {
  try {
    void window.electronAPI?.store?.showBlueprintNotification?.({
      messageId,
      name,
    });
  } catch {
    // ignore — best-effort OS notification
  }
}
