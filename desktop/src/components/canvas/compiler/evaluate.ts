/**
 * Evaluates compiled JS code and extracts the default export.
 * Uses new Function() with the scope map for isolation.
 */

import { MODULE_SCOPE } from './scope'

export type EvaluateResult = {
  component: React.ComponentType<Record<string, unknown>>
  error?: undefined
} | {
  error: string
  component?: undefined
}

export const evaluate = (code: string): EvaluateResult => {
  try {
    const __exports: Record<string, unknown> = {}

    // Wrap code in a function that receives __scope and __exports
    const fn = new Function('__scope', '__exports', code)
    fn(MODULE_SCOPE, __exports)

    const component = __exports.default
    if (typeof component !== 'function') {
      return { error: 'Compiled module does not have a default export (must be a React component).' }
    }

    return { component: component as React.ComponentType<Record<string, unknown>> }
  } catch (err) {
    return { error: `Evaluation failed: ${(err as Error).message}` }
  }
}
