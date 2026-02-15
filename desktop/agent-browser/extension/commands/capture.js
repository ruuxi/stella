/**
 * Capture command handlers: screenshot, snapshot, content, evaluate, pdf.
 */
import { getActiveTab } from './tabs.js';
import { setRefMap, resolveSelector, buildRoleMatcherScript } from '../lib/selector.js';
import { executeSnapshot } from '../lib/snapshot.js';
import { ensureDebugger } from '../lib/debugger.js';

export async function handleScreenshot(command) {
  const tab = await getActiveTab();

  // Use chrome.tabs.captureVisibleTab for viewport screenshot (no debugger needed)
  const format = command.format || 'jpeg';
  const quality = command.quality ?? (format === 'jpeg' ? 60 : undefined);
  const dataUrl = await chrome.tabs.captureVisibleTab(null, {
    format,
    quality,
  });

  // Strip data URL prefix to get base64
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');

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

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selector) => {
      if (selector) {
        const el = document.querySelector(selector);
        return el ? el.innerHTML : null;
      }
      return document.documentElement.outerHTML;
    },
    args: [command.selector || null],
    world: 'MAIN',
  });

  return {
    id: command.id,
    success: true,
    data: { content: result?.result || '' },
  };
}

export async function handleEvaluate(command) {
  const tab = await getActiveTab();
  const expression = command.expression || command.script;

  if (!expression) throw new Error('Expression is required for evaluate');

  // Use CDP Runtime.evaluate to bypass CSP restrictions on new Function/eval
  await ensureDebugger(tab.id);
  const result = await chrome.debugger.sendCommand(
    { tabId: tab.id },
    'Runtime.evaluate',
    { expression, returnByValue: true }
  );

  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(msg);
  }

  const value = result.result?.value;
  return {
    id: command.id,
    success: true,
    data: {
      value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''),
      type: typeof value,
    },
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

  await ensureDebugger(tab.id);
  const evalResult = await chrome.debugger.sendCommand(
    { tabId: tab.id }, 'Runtime.evaluate',
    { expression: script, returnByValue: true }
  );

  if (evalResult.exceptionDetails) {
    throw new Error(evalResult.exceptionDetails.exception?.description || evalResult.exceptionDetails.text);
  }

  return {
    id: command.id,
    success: true,
    data: { text: evalResult.result?.value ?? '' },
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

  await ensureDebugger(tab.id);
  const evalResult = await chrome.debugger.sendCommand(
    { tabId: tab.id }, 'Runtime.evaluate',
    { expression: script, returnByValue: true }
  );

  if (evalResult.exceptionDetails) {
    throw new Error(evalResult.exceptionDetails.exception?.description || evalResult.exceptionDetails.text);
  }

  return {
    id: command.id,
    success: true,
    data: { value: evalResult.result?.value },
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
