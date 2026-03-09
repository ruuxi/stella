/**
 * Capture command handlers: screenshot, snapshot, content, evaluate, pdf.
 */
import { getActiveTab } from './tabs.js';
import { setRefMap, resolveSelector, buildRoleMatcherScript } from '../lib/selector.js';
import { executeSnapshot } from '../lib/snapshot.js';
import { ensureDebugger } from '../lib/debugger.js';

function buildElementExpression(selector, onFoundSource) {
  const resolved = resolveSelector(selector);
  if (resolved.isRef) {
    const finder = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);
    return `(() => { const el = ${finder.trim()}; ${onFoundSource} })()`;
  }
  return `(() => { const el = document.querySelector(${JSON.stringify(resolved.css)}); ${onFoundSource} })()`;
}

async function evaluateExpression(tabId, expression) {
  await ensureDebugger(tabId);
  const result = await chrome.debugger.sendCommand(
    { tabId },
    'Runtime.evaluate',
    { expression, returnByValue: true }
  );

  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(msg);
  }

  return result.result?.value;
}

async function getSelectorClip(tabId, selector) {
  const clip = await evaluateExpression(
    tabId,
    buildElementExpression(
      selector,
      `
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
          scale: 1,
        };
      `
    )
  );

  if (!clip) {
    throw new Error(`Selector not found or not visible: ${selector}`);
  }

  return clip;
}

export async function handleScreenshot(command) {
  const tab = await getActiveTab();
  if (command.path) {
    throw new Error('Custom screenshot paths are not supported in extension mode');
  }

  const format = command.format || 'jpeg';
  const quality = command.quality ?? (format === 'jpeg' ? 60 : undefined);
  /** @type {Record<string, unknown>} */
  const params = {
    format,
    captureBeyondViewport: Boolean(command.fullPage || command.selector),
  };
  if (format === 'jpeg') {
    params.quality = quality;
  }

  await ensureDebugger(tab.id);

  if (command.fullPage) {
    const metrics = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getLayoutMetrics');
    const contentSize = metrics.contentSize;
    params.clip = {
      x: 0,
      y: 0,
      width: contentSize.width,
      height: contentSize.height,
      scale: 1,
    };
  } else if (command.selector) {
    params.clip = await getSelectorClip(tab.id, command.selector);
  }

  const result = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', params);
  const base64 = result.data;

  return {
    id: command.id,
    success: true,
    data: {
      base64,
      format,
    },
  };
}

export async function handleSnapshot(command) {
  const tab = await getActiveTab();

  const options = {
    interactive: command.interactive ?? false,
    cursor: command.cursor ?? false,
    maxDepth: command.maxDepth ?? command.depth,
    compact: command.compact ?? false,
    selector: command.selector,
  };

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: executeSnapshot,
    args: [options],
    world: 'MAIN',
  });

  if (result?.error) throw new Error(result.error.message || String(result.error));

  const snapshot = result?.result;
  if (!snapshot) throw new Error('Snapshot generation failed');

  // Update the ref map for subsequent commands
  setRefMap(snapshot.refs || {});

  return {
    id: command.id,
    success: true,
    data: {
      snapshot: snapshot.tree,
      refs: snapshot.refs,
    },
  };
}

export async function handleContent(command) {
  const tab = await getActiveTab();
  let html = '';

  if (command.selector) {
    html =
      (await evaluateExpression(
        tab.id,
        buildElementExpression(command.selector, 'return el ? el.innerHTML : null;')
      )) || '';
  } else {
    html =
      (await evaluateExpression(
        tab.id,
        'document.documentElement ? document.documentElement.outerHTML : ""'
      )) || '';
  }

  return {
    id: command.id,
    success: true,
    data: { html },
  };
}

export async function handleEvaluate(command) {
  const tab = await getActiveTab();
  const expression = command.expression || command.script;

  if (!expression) throw new Error('Expression is required for evaluate');

  const value = await evaluateExpression(tab.id, expression);
  return {
    id: command.id,
    success: true,
    data: { result: value },
  };
}

export async function handleGetText(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for gettext');

  const resolved = resolveSelector(selector);

  let script;
  if (resolved.isRef) {
    const finder = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);
    script = `(() => { const el = ${finder.trim()}; return el ? el.textContent.trim() : null; })()`;
  } else {
    script = `(() => { const el = document.querySelector(${JSON.stringify(resolved.css)}); return el ? el.textContent.trim() : null; })()`;
  }

  return {
    id: command.id,
    success: true,
    data: { text: (await evaluateExpression(tab.id, script)) ?? '' },
  };
}

export async function handleGetAttribute(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  const attribute = command.attribute || command.name;
  if (!selector) throw new Error('Selector is required');
  if (!attribute) throw new Error('Attribute name is required');

  const resolved = resolveSelector(selector);

  let script;
  if (resolved.isRef) {
    const finder = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);
    script = `(() => { const el = ${finder.trim()}; return el ? el.getAttribute(${JSON.stringify(attribute)}) : null; })()`;
  } else {
    script = `(() => { const el = document.querySelector(${JSON.stringify(resolved.css)}); return el ? el.getAttribute(${JSON.stringify(attribute)}) : null; })()`;
  }

  return {
    id: command.id,
    success: true,
    data: { value: await evaluateExpression(tab.id, script) },
  };
}

export async function handlePdf(command) {
  const tab = await getActiveTab();
  await ensureDebugger(tab.id);

  const result = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.printToPDF', {
    landscape: command.landscape || false,
    printBackground: command.printBackground ?? true,
    paperWidth: command.paperWidth,
    paperHeight: command.paperHeight,
  });

  return {
    id: command.id,
    success: true,
    data: { base64: result.data, format: 'pdf' },
  };
}
