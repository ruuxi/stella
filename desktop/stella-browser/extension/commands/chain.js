/**
 * Chain command handler - executes multiple steps sequentially
 * within the extension, with implicit selector waits and optional delays.
 *
 * This eliminates per-step round trips through the native bridge.
 */
import { assertCurrentOwnerLease, getActiveTab } from './tabs.js';
import { resolveSelector, buildRoleMatcherScript } from '../lib/selector.js';
import { evaluateRuntime } from '../lib/debugger.js';

export const MAX_CHAIN_STEPS = 100;
export const MAX_CHAIN_RUNTIME_MS = 45_000;
const MAX_CHAIN_STEP_TIMEOUT_MS = 30_000;
export const CHAIN_ACTION_ALLOWLIST = new Set([
  'healthcheck',
  'navigate', 'open', 'back', 'forward', 'reload', 'url', 'title',
  'click', 'fill', 'type', 'hover', 'select', 'press', 'scroll', 'clear',
  'check', 'uncheck', 'focus', 'dblclick', 'wait',
  'screenshot', 'snapshot', 'content', 'evaluate', 'gettext', 'getattribute',
  'innertext', 'innerhtml', 'inputvalue', 'boundingbox', 'scrollintoview',
  'isvisible', 'isenabled', 'ischecked', 'count', 'styles', 'waitforurl',
  'bringtofront',
  'requests', 'responsebody', 'route', 'unroute', 'har_start', 'har_stop',
  'clipboard',
  'mousemove', 'mousedown', 'mouseup', 'drag', 'keydown', 'keyup', 'inserttext',
  'tab_new', 'tab_list', 'tab_switch', 'tab_close',
  'cookies_get', 'cookies_set', 'cookies_clear',
  'site_mod_set', 'site_mod_list', 'site_mod_remove', 'site_mod_toggle',
]);

const MAX_JSON_DEPTH = 20;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ALLOWED_CHAIN_KEYS = new Set([
  'type',
  'id',
  'action',
  'ownerId',
  'ownerLeaseId',
  'ownerLeaseIssuedAt',
  'tabId',
  'steps',
  'delay',
  'waitForSelector',
  'waitTimeout',
  'abortOnError',
  'returnSnapshot',
  'returnScreenshot',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function validateSafeValue(value, path, depth = 0) {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(`${path} exceeds the maximum object depth`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateSafeValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (!isPlainObject(value)) {
    throw new Error(`${path} must contain only plain JSON objects`);
  }
  for (const [key, nested] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      throw new Error(`${path} contains unsafe key: ${key}`);
    }
    validateSafeValue(nested, `${path}.${key}`, depth + 1);
  }
}

function validateOptionalBoolean(command, key) {
  if (command[key] !== undefined && typeof command[key] !== 'boolean') {
    throw new Error(`Chain option ${key} must be a boolean`);
  }
}

export function validateChainCommand(command) {
  if (!isPlainObject(command)) {
    throw new Error('Chain command must be a plain object');
  }
  for (const key of Object.keys(command)) {
    if (!ALLOWED_CHAIN_KEYS.has(key)) {
      throw new Error(`Unknown or unsafe chain option: ${key}`);
    }
  }
  if (!Array.isArray(command.steps)) {
    throw new Error('Chain steps must be an array');
  }
  if (command.steps.length === 0) {
    throw new Error('Chain must contain at least one step');
  }
  if (command.steps.length > MAX_CHAIN_STEPS) {
    throw new Error(`Chain has ${command.steps.length} steps; maximum is ${MAX_CHAIN_STEPS}`);
  }

  command.steps.forEach((step, index) => {
    if (!isPlainObject(step)) {
      throw new Error(`Chain step ${index} must be a plain object`);
    }
    validateSafeValue(step, `steps[${index}]`);
    if (typeof step.action !== 'string' || !step.action.trim()) {
      throw new Error(`Chain step ${index} must have a non-empty string action`);
    }
    if (!CHAIN_ACTION_ALLOWLIST.has(step.action)) {
      throw new Error(`Chain step ${index} action is not allowed: ${step.action}`);
    }
    if (step.tabId !== undefined && (!Number.isInteger(step.tabId) || step.tabId <= 0)) {
      throw new Error(`Chain step ${index} tabId must be a positive integer`);
    }
    if (
      step.timeout !== undefined &&
      (!Number.isFinite(step.timeout) ||
        step.timeout <= 0 ||
        step.timeout > MAX_CHAIN_STEP_TIMEOUT_MS)
    ) {
      throw new Error(`Chain step ${index} timeout must be between 1 and ${MAX_CHAIN_STEP_TIMEOUT_MS}ms`);
    }
    if (
      step.action === 'drag' &&
      step.steps !== undefined &&
      (!Number.isInteger(step.steps) || step.steps <= 0 || step.steps > 100)
    ) {
      throw new Error(`Chain step ${index} drag steps must be between 1 and 100`);
    }
  });

  if (command.tabId !== undefined && (!Number.isInteger(command.tabId) || command.tabId <= 0)) {
    throw new Error('Chain tabId must be a positive integer');
  }
  for (const key of [
    'waitForSelector',
    'abortOnError',
    'returnSnapshot',
    'returnScreenshot',
  ]) {
    validateOptionalBoolean(command, key);
  }
  if (
    command.waitTimeout !== undefined &&
    (!Number.isFinite(command.waitTimeout) ||
      command.waitTimeout < 0 ||
      command.waitTimeout > MAX_CHAIN_STEP_TIMEOUT_MS)
  ) {
    throw new Error(`Chain option waitTimeout must be between 0 and ${MAX_CHAIN_STEP_TIMEOUT_MS}ms`);
  }

  if (command.delay !== undefined) {
    if (!isPlainObject(command.delay)) {
      throw new Error('Chain option delay must be an object with min/max milliseconds');
    }
    const delayKeys = Object.keys(command.delay);
    if (delayKeys.some((key) => key !== 'min' && key !== 'max')) {
      throw new Error('Chain option delay only accepts min and max');
    }
    const min = command.delay.min ?? 300;
    const max = command.delay.max ?? 1200;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0 || min > max) {
      throw new Error('Chain delay min/max must be non-negative numbers with min <= max');
    }
  }

  return command.steps;
}

/**
 * Random delay between min and max milliseconds (gaussian-ish distribution).
 */
function randomDelay(min = 300, max = 1200) {
  // Use average of two randoms for a more natural bell-curve distribution
  const r = (Math.random() + Math.random()) / 2;
  const ms = min + r * (max - min);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait for a selector to appear in the DOM via polling.
 * Returns true if found within timeout, false otherwise.
 */
async function waitForStepSelector(command, selector, timeout = 10000) {
  if (!selector) return true;

  const startTime = Date.now();
  const pollInterval = 200;

  while (Date.now() - startTime < timeout) {
    try {
      const tab = await getActiveTab(command);
      const resolved = resolveSelector(selector, command.ownerId, tab.id);
      if (resolved.isRef) {
        const finder = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);
        if (await evaluateRuntime(tab.id, `!!(${finder.trim()})`)) return true;
      } else {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => !!document.querySelector(sel),
          args: [resolved.css],
        });
        if (result?.result) return true;
      }
    } catch {
      // Page might be navigating, keep polling
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }
  return false;
}

/**
 * Execute a chain of steps sequentially.
 * @param {object} command - The chain command
 * @param {object} handlers - The HANDLERS map from background.js
 * @returns {object} Response with per-step results
 */
export async function handleChain(command, handlers) {
  const steps = validateChainCommand(command);
  const delayConfig = command.delay
    ? { min: command.delay.min ?? 300, max: command.delay.max ?? 1200 }
    : null;
  const shouldWait = command.waitForSelector !== false;
  const waitTimeout = command.waitTimeout || 10000;
  const abortOnError = command.abortOnError !== false;

  const results = [];
  const chainStart = Date.now();
  const deadline = chainStart + MAX_CHAIN_RUNTIME_MS;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStart = Date.now();
    const stepCommand = {
      ...step,
      tabId: step.tabId ?? command.tabId,
      id: `${command.id}_s${i}`,
      ownerId: command.ownerId,
      ownerLeaseId: command.ownerLeaseId,
      ownerLeaseIssuedAt: command.ownerLeaseIssuedAt,
    };
    const remainingBeforeWait = deadline - Date.now();
    if (remainingBeforeWait <= 0) {
      results.push({
        step: i,
        action: step.action,
        success: false,
        error: `Chain exceeded its ${MAX_CHAIN_RUNTIME_MS}ms execution budget`,
        durationMs: 0,
      });
      break;
    }
    stepCommand.timeout = Math.min(
      stepCommand.timeout ?? MAX_CHAIN_STEP_TIMEOUT_MS,
      remainingBeforeWait,
    );
    if (stepCommand.tabId === undefined) delete stepCommand.tabId;

    // 1. Implicit wait: if step has a selector/ref, wait for it to appear
    const selector = step.selector || step.ref;
    if (shouldWait && selector) {
      const found = await waitForStepSelector(
        stepCommand,
        selector,
        Math.min(waitTimeout, remainingBeforeWait),
      );
      if (!found) {
        results.push({
          step: i,
          action: step.action,
          success: false,
          error: `Timeout waiting for selector: ${selector}`,
          durationMs: Date.now() - stepStart,
        });
        if (abortOnError) break;
        continue;
      }
    }

    const remainingBeforeAction = deadline - Date.now();
    if (remainingBeforeAction <= 0) {
      results.push({
        step: i,
        action: step.action,
        success: false,
        error: `Chain exceeded its ${MAX_CHAIN_RUNTIME_MS}ms execution budget`,
        durationMs: Date.now() - stepStart,
      });
      break;
    }
    stepCommand.timeout = Math.min(stepCommand.timeout, remainingBeforeAction);

    // A replacement kernel can claim this owner while a prior chain step or
    // implicit wait is still running. Revalidate at the execution boundary so
    // the admitted chain cannot continue acting under its superseded lease.
    await assertCurrentOwnerLease(stepCommand);

    // 2. Look up and execute the handler
    const handler = handlers[step.action];
    if (!handler) {
      results.push({
        step: i,
        action: step.action,
        success: false,
        error: `Unknown action: ${step.action}`,
        durationMs: Date.now() - stepStart,
      });
      if (abortOnError) break;
      continue;
    }

    try {
      const response = await handler(stepCommand);

      results.push({
        step: i,
        action: step.action,
        success: response.success !== false,
        data: response.data,
        ...(response.success === false
          ? { error: response.error || 'extension action failed without an error message' }
          : {}),
        durationMs: Date.now() - stepStart,
      });

      if (response.success === false && abortOnError) break;
    } catch (err) {
      results.push({
        step: i,
        action: step.action,
        success: false,
        error: err.message || String(err),
        durationMs: Date.now() - stepStart,
      });
      if (abortOnError) break;
    }

    // 3. Optional delay between steps (skip after last step)
    if (delayConfig && i < steps.length - 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await randomDelay(
        Math.min(delayConfig.min, remaining),
        Math.min(delayConfig.max, remaining),
      );
    }
  }

  // 4. Build response
  const responseData = {
    results,
    completed: results.filter(r => r.success).length,
    total: steps.length,
    totalDurationMs: Date.now() - chainStart,
  };
  let requestedOutputError = null;
  const failedStep = results.find((result) => result.success === false);
  const failedStepError = failedStep
    ? `Chain step ${failedStep.step} (${steps[failedStep.step]?.action || 'unknown'}) failed: ${failedStep.error || 'extension action failed without an error message'}`
    : null;

  // 5. Optional final snapshot
  if (command.returnSnapshot) {
    try {
      if (!handlers.snapshot) {
        throw new Error('Snapshot handler is unavailable');
      }
      const snap = await handlers.snapshot({
        id: `${command.id}_snap`,
        action: 'snapshot',
        interactive: true,
        compact: true,
        ownerId: command.ownerId,
        ownerLeaseId: command.ownerLeaseId,
        ownerLeaseIssuedAt: command.ownerLeaseIssuedAt,
        tabId: command.tabId,
      });
      if (snap?.success === false) {
        throw new Error(snap.error || 'Snapshot capture failed');
      }
      if (snap?.data?.snapshot === undefined) {
        throw new Error('Snapshot capture returned no snapshot data');
      }
      responseData.snapshot = snap.data.snapshot;
    } catch (error) {
      requestedOutputError = error?.message || String(error);
      responseData.snapshotError = requestedOutputError;
    }
  }

  // 6. Optional final screenshot
  if (command.returnScreenshot) {
    const defaultFormat = 'jpeg';
    try {
      if (!handlers.screenshot) {
        throw new Error('Screenshot handler is unavailable');
      }
      const shot = await handlers.screenshot({
        id: `${command.id}_shot`,
        action: 'screenshot',
        ownerId: command.ownerId,
        ownerLeaseId: command.ownerLeaseId,
        ownerLeaseIssuedAt: command.ownerLeaseIssuedAt,
        tabId: command.tabId,
      });
      if (shot?.success === false) {
        const error = new Error(shot.error || 'Screenshot capture failed');
        error.format = shot.data?.format || defaultFormat;
        throw error;
      }
      if (typeof shot?.data?.base64 !== 'string' || !shot.data.base64) {
        const error = new Error('Screenshot capture returned no image data');
        error.format = shot?.data?.format || defaultFormat;
        throw error;
      }
      responseData.screenshot = shot.data?.base64;
      responseData.screenshotFormat = shot.data?.format || defaultFormat;
    } catch (error) {
      requestedOutputError = error?.message || String(error);
      responseData.screenshotError = {
        error: requestedOutputError,
        format: error?.format || defaultFormat,
      };
    }
  }

  return {
    id: command.id,
    success: results.every(r => r.success) && requestedOutputError == null,
    ...(requestedOutputError || failedStepError
      ? { error: requestedOutputError || failedStepError }
      : {}),
    data: responseData,
  };
}
