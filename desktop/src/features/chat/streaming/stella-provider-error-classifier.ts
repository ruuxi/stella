export type StellaProviderErrorKind =
  | 'account-auth'
  | 'billing'
  | 'chatgpt-usage-limit'
  | 'claude-code-login'
  | 'content-blocked'
  | 'context-limit'
  | 'malformed-request'
  | 'model-restriction'
  | 'network'
  | 'provider-access'
  | 'rate-limit'
  | 'service-unavailable'
  | 'sign-in-required'
  | 'timeout'
  | 'unknown'

export type StellaProviderErrorClassification = {
  kind: StellaProviderErrorKind
  message: string
  detail?: string
}

const signInRequiredMatchers = ['sign in required'] as const

const billingMatchers = [
  'usage limit reached',
  'managed-model limits reached',
] as const

const chatGptUsageLimitMatcher = 'you have hit your chatgpt usage limit'

const rateLimitMatchers = [
  'rate limit exceeded',
  'too many requests',
] as const

const authMatchers = [
  'unauthorized',
  'unauthenticated',
  'invalid token',
  'token expired',
  'expired token',
] as const

const providerCredentialMatchers = [
  'authentication failed',
  'api key',
  'forbidden',
  'permission denied',
] as const

const claudeCodeLoginRequiredMatcher = '[claude-code/login-required]'

const modelRestrictionMatchers = [
  'unsupported stella model selection',
  'invalid stella model selection',
  'model not available',
  'model is not available',
  'model not found',
  'unknown model',
] as const

const serviceUnavailableMatchers = [
  'upstream gateway is not configured',
  'stella runtime returned no response body',
  'stella runtime error: 5',
  'failed to generate stella completion',
  'streaming completion failed',
  'server_error',
  'server_is_overloaded',
  'service_unavailable_error',
] as const

const contextLimitMatchers = [
  'context overflow',
  'context length',
  'context window',
  'maximum context',
  'max context',
  'too many tokens',
  'input is too long',
  'request too large',
  'output-token cap',
] as const

const timeoutMatchers = [
  'timed out',
  'timeout',
  'deadline exceeded',
  'did not produce activity',
] as const

const networkMatchers = [
  'connection refused',
  'connection reset',
  'connection closed',
  'network error',
  'network offline',
  'fetch failed',
  'failed to fetch',
  'socket hang up',
  'unexpected eof',
  'premature close',
  'econnrefused',
  'econnreset',
  'enotfound',
] as const

const contentBlockedMatchers = [
  'blocked by policy',
  'content filter',
  'content policy',
  'content_filter',
  'content blocked',
  'moderation blocked',
  'prompt blocked',
  'prohibited content',
  'safety filter',
  'safety refusal',
  'stop reason: "refusal"',
  'stop reason: "safety"',
] as const

const malformedRequestMatchers = [
  'bad request',
  'invalid_request_error',
  'request validation',
  'stella request body must be valid json',
  'validation error',
  'received text_delta for non-text content',
  'received text_end for non-text content',
  'received thinking_delta for non-thinking content',
  'received thinking_end for non-thinking content',
  'received toolcall_delta for non-toolcall content',
] as const

const includesAny = (
  normalized: string,
  matchers: readonly string[],
): boolean => matchers.some((matcher) => normalized.includes(matcher))

const statusCodeFromError = (normalized: string): number | null => {
  const match = normalized.match(
    /\b(?:http(?: status)?|status(?: code)?|error(?: code)?|code)\s*[:=]?\s*([45]\d{2})\b/i,
  )
  if (!match?.[1]) return null
  const status = Number(match[1])
  return Number.isFinite(status) ? status : null
}

const nestedErrorMessage = (value: unknown, depth = 0): string | null => {
  if (depth > 4 || value == null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of ['message', 'error', 'detail', 'reason']) {
    const candidate = nestedErrorMessage(record[key], depth + 1)
    if (candidate) return candidate
  }
  return null
}

const extractJsonErrorMessage = (message: string): string | null => {
  const candidates = [message]
  const objectStart = message.indexOf('{')
  const objectEnd = message.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(message.slice(objectStart, objectEnd + 1))
  }
  for (const candidate of candidates) {
    try {
      const extracted = nestedErrorMessage(JSON.parse(candidate))
      if (extracted) return extracted
    } catch {
      // The error is ordinary text, not a JSON envelope.
    }
  }
  return null
}

const redactErrorSecrets = (message: string): string =>
  message
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk)-[a-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|token|secret)=)[^&\s]+/gi,
      '$1[redacted]',
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|secret)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    )

const friendlyUnknownErrorDetail = (message: string): string => {
  const extracted = extractJsonErrorMessage(message) ?? message
  const firstUsefulLine =
    extracted.split(/\n\s*(?:at\s+|caused by:)/i, 1)[0] ?? ''
  const cleaned = redactErrorSecrets(firstUsefulLine)
    .replace(
      /^\s*(?:codex|provider|stella runtime)\s+error(?:\s*\([^)]*\))?\s*[:=-]\s*/i,
      '',
    )
    .replace(/^\s*\[(?:error|fatal)[^\]]*\]\s*/i, '')
    .replace(/^\s*\{\{\s*(?:error|fatal)[^}]*\}\}\s*/i, '')
    .replace(/^\s*(?:error|fatal|exception)\s*[:=-]\s*/i, '')
    .replace(
      /^\s*(?:http(?: status)?|status(?: code)?|error(?: code)?|code)\s*[:=]?\s*[45]\d{2}\s*[:=-]?\s*/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()
  if (
    !cleaned ||
    /^(?:unknown error|an unknown error occurred|something went wrong)$/i.test(
      cleaned,
    )
  ) {
    return 'Stella could not finish this response. Please try again.'
  }
  if (cleaned.length <= 280) return cleaned
  return `${cleaned.slice(0, 277).trimEnd()}…`
}

export const classifyStellaProviderError = (
  reason: string | null | undefined,
): StellaProviderErrorClassification => {
  const message = (reason ?? '').trim()
  const normalized = message.toLowerCase()
  const statusCode = statusCodeFromError(normalized)

  if (normalized.includes(claudeCodeLoginRequiredMatcher)) {
    return { kind: 'claude-code-login', message }
  }
  if (includesAny(normalized, signInRequiredMatchers)) {
    return { kind: 'sign-in-required', message }
  }
  if (normalized.includes(chatGptUsageLimitMatcher)) {
    return { kind: 'chatgpt-usage-limit', message }
  }
  if (includesAny(normalized, billingMatchers)) {
    return { kind: 'billing', message }
  }
  if (includesAny(normalized, rateLimitMatchers) || statusCode === 429) {
    return { kind: 'rate-limit', message }
  }
  if (includesAny(normalized, authMatchers)) {
    return { kind: 'account-auth', message }
  }
  if (
    includesAny(normalized, providerCredentialMatchers) ||
    statusCode === 401 ||
    statusCode === 403
  ) {
    return { kind: 'provider-access', message }
  }
  if (includesAny(normalized, modelRestrictionMatchers)) {
    return { kind: 'model-restriction', message }
  }
  if (includesAny(normalized, contextLimitMatchers) || statusCode === 413) {
    return { kind: 'context-limit', message }
  }
  if (includesAny(normalized, contentBlockedMatchers)) {
    return { kind: 'content-blocked', message }
  }
  if (
    includesAny(normalized, timeoutMatchers) ||
    statusCode === 408 ||
    statusCode === 504
  ) {
    return { kind: 'timeout', message }
  }
  if (includesAny(normalized, networkMatchers)) {
    return { kind: 'network', message }
  }
  if (
    includesAny(normalized, serviceUnavailableMatchers) ||
    (statusCode !== null && statusCode >= 500)
  ) {
    return { kind: 'service-unavailable', message }
  }
  if (
    includesAny(normalized, malformedRequestMatchers) ||
    statusCode === 400 ||
    statusCode === 422
  ) {
    return { kind: 'malformed-request', message }
  }
  return {
    kind: 'unknown',
    message,
    detail: friendlyUnknownErrorDetail(message),
  }
}

const LIMIT_OR_AUTH_KINDS = new Set<StellaProviderErrorKind>([
  'account-auth',
  'billing',
  'chatgpt-usage-limit',
  'claude-code-login',
  'provider-access',
  'rate-limit',
  'sign-in-required',
])

export const isStellaLimitOrAuthClassification = (
  classification: StellaProviderErrorClassification,
): boolean => LIMIT_OR_AUTH_KINDS.has(classification.kind)
