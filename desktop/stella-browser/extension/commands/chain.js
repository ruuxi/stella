/**
 * Chain command handler — executes multiple steps sequentially
 * within the extension, with implicit waits and human-like delays.
 *
 * This eliminates per-step round trips through daemon/CLI.
 */
import { getActiveTab } from './tabs.js';
import { resolveSelector, buildRoleMatcherScript } from '../lib/selector.js';
import { ensureDebugger } from '../lib/debugger.js';

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
async function waitForStepSelector(selector, timeout = 10000) {
  if (!selector) return true;

  const resolved = resolveSelector(selector);
  const startTime = Date.now();
  const pollInterval = 200;

  while (Date.now() - startTime < timeout) {
    try {
      const tab = await getActiveTab();
      if (resolved.isRef) {
        const finder = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);
        await ensureDebugger(tab.id);
        const evalResult = await chrome.debugger.sendCommand(
          { tabId: tab.id }, 'Runtime.evaluate',
          { expression: `!!(${finder.trim()})`, returnByValue: true }
        );
        if (evalResult.result?.value) return true;
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
  const steps = command.steps || [];
  const delayConfig = command.delay || { min: 300, max: 1200 };
  const shouldWait = command.waitForSelector !== false;
  const waitTimeout = command.waitTimeout || 10000;
  const abortOnError = command.abortOnError !== false;

  const results = [];
  const chainStart = Date.now();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStart = Date.now();

    // 1. Implicit wait: if step has a selector/ref, wait for it to appear
    const selector = step.selector || step.ref;
    if (shouldWait && selector) {
      const found = await waitForStepSelector(selector, waitTimeout);
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
      const stepCommand = { ...step, id: `${command.id}_s${i}` };
      const response = await handler(stepCommand);

      results.push({
        step: i,
        action: step.action,
        success: response.success !== false,
        data: response.data,
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

    // 3. Human-like delay between steps (skip after last step)
    if (i < steps.length - 1) {
      await randomDelay(delayConfig.min, delayConfig.max);
    }
  }

  // 4. Build response
  const responseData = {
    results,
    completed: results.filter(r => r.success).length,
    total: steps.length,
    totalDurationMs: Date.now() - chainStart,
  };

  // 5. Optional final snapshot
  if (command.returnSnapshot && handlers.snapshot) {
    try {
      const snap = await handlers.snapshot({
        id: `${command.id}_snap`,
        action: 'snapshot',
        interactive: true,
        compact: true,
      });
      responseData.snapshot = snap.data?.snapshot;
    } catch { /* non-fatal */ }
  }

  // 6. Optional final screenshot
  if (command.returnScreenshot && handlers.screenshot) {
    try {
      const shot = await handlers.screenshot({
        id: `${command.id}_shot`,
        action: 'screenshot',
      });
      responseData.screenshot = shot.data?.base64;
    } catch { /* non-fatal */ }
  }

  return {
    id: command.id,
    success: results.every(r => r.success),
    data: responseData,
  };
}
