export function getSocialActionErrorMessage(
  fallback: string,
  error: unknown,
): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
