/**
 * Module scope map for runtime-compiled canvas components.
 *
 * Maps module specifiers to objects that generated code can access
 * via __scope['module-name'].
 */

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as Recharts from 'recharts'
import { useIntegrationRequest } from '@/hooks/use-integration-request'

// Collect React exports for convenience
const reactScope = {
  ...React,
  default: React,
}

/**
 * The scope object available to generated components.
 * Keys are module specifiers that the AI might use in import statements.
 */
export const MODULE_SCOPE: Record<string, unknown> = {
  'react': reactScope,
  'react/jsx-runtime': jsxRuntime,
  'recharts': Recharts,
  '@stella/integration': { useIntegrationRequest },
}
