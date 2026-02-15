/**
 * Element query command handlers: innertext, innerhtml, inputvalue,
 * boundingbox, waitforurl, scrollintoview, isvisible, isenabled,
 * ischecked, count, styles.
 */
import { getActiveTab } from './tabs.js';
import { resolveSelector, buildRoleMatcherScript } from '../lib/selector.js';
import { ensureDebugger } from '../lib/debugger.js';

/**
 * Inject a script that finds an element and runs code on it.
 * Uses CDP Runtime.evaluate to bypass CSP restrictions.
 */
async function queryElement(tabId, selector, scriptBody) {
  const resolved = resolveSelector(selector);
  let script;

  if (resolved.isRef) {
    const finder = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);
    script = `(() => { const el = ${finder.trim()}; if (!el) throw new Error('Element not found'); ${scriptBody} })()`;
  } else {
    script = `(() => { const el = document.querySelector(${JSON.stringify(resolved.css)}); if (!el) throw new Error('Element not found: ${resolved.css}'); ${scriptBody} })()`;
  }

  await ensureDebugger(tabId);
  const result = await chrome.debugger.sendCommand(
    { tabId },
    'Runtime.evaluate',
    { expression: script, returnByValue: true }
  );

  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(msg);
  }

  return result.result?.value;
}

export async function handleInnerText(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for innertext');

  const text = await queryElement(tab.id, selector, 'return el.innerText;');
  return { id: command.id, success: true, data: { text } };
}

export async function handleInnerHtml(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for innerhtml');

  const html = await queryElement(tab.id, selector, 'return el.innerHTML;');
  return { id: command.id, success: true, data: { html } };
}

export async function handleInputValue(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for inputvalue');

  const value = await queryElement(tab.id, selector, 'return el.value ?? "";');
  return { id: command.id, success: true, data: { value } };
}

export async function handleBoundingBox(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for boundingbox');

  const box = await queryElement(tab.id, selector, `
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  `);
  return { id: command.id, success: true, data: { box } };
}

export async function handleScrollIntoView(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for scrollintoview');

  await queryElement(tab.id, selector, `
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;
  `);
  return { id: command.id, success: true, data: { scrolled: true } };
}

export async function handleIsVisible(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for isvisible');

  const resolved = resolveSelector(selector);
  let script;

  const visibilityCheck = `
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  `;

  if (resolved.isRef) {
    const finder = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);
    script = `(() => { const el = ${finder.trim()}; if (!el) return false; ${visibilityCheck} })()`;
  } else {
    script = `(() => { const el = document.querySelector(${JSON.stringify(resolved.css)}); if (!el) return false; ${visibilityCheck} })()`;
  }

  await ensureDebugger(tab.id);
  const result = await chrome.debugger.sendCommand(
    { tabId: tab.id }, 'Runtime.evaluate',
    { expression: script, returnByValue: true }
  );

  return { id: command.id, success: true, data: { visible: !!result.result?.value } };
}

export async function handleIsEnabled(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for isenabled');

  const enabled = await queryElement(tab.id, selector, 'return !el.disabled;');
  return { id: command.id, success: true, data: { enabled } };
}

export async function handleIsChecked(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for ischecked');

  const checked = await queryElement(tab.id, selector, 'return !!el.checked;');
  return { id: command.id, success: true, data: { checked } };
}

export async function handleCount(command) {
  const tab = await getActiveTab();
  const selector = command.selector;
  if (!selector) throw new Error('Selector is required for count');

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => document.querySelectorAll(sel).length,
    args: [selector],
    world: 'MAIN',
  });

  return { id: command.id, success: true, data: { count: result?.result ?? 0 } };
}

export async function handleStyles(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for styles');

  const resolved = resolveSelector(selector);
  const extractScript = `
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: el.innerText?.trim().slice(0, 80) || null,
      box: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      styles: {
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        fontFamily: s.fontFamily.split(',')[0].trim().replace(/"/g, ''),
        color: s.color,
        backgroundColor: s.backgroundColor,
        borderRadius: s.borderRadius,
        border: s.border !== 'none' && s.borderWidth !== '0px' ? s.border : null,
        boxShadow: s.boxShadow !== 'none' ? s.boxShadow : null,
        padding: s.padding,
      },
    };
  `;

  // For CSS selectors, support multiple elements via CDP Runtime.evaluate
  if (!resolved.isRef) {
    const script = `(() => {
      const els = document.querySelectorAll(${JSON.stringify(resolved.css)});
      return Array.from(els).map(el => {
        ${extractScript}
      });
    })()`;

    await ensureDebugger(tab.id);
    const result = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Runtime.evaluate',
      { expression: script, returnByValue: true }
    );

    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(msg);
    }

    return { id: command.id, success: true, data: { elements: result.result?.value || [] } };
  }

  // For refs, single element
  const element = await queryElement(tab.id, selector, extractScript);
  return { id: command.id, success: true, data: { elements: [element] } };
}

/**
 * Check if a URL matches a pattern (glob-style with * wildcards).
 */
function urlMatches(url, pattern) {
  if (!pattern) return true;

  // Exact match
  if (url === pattern) return true;

  // Convert glob to regex: * matches anything except nothing
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
  return regex.test(url);
}

export async function handleWaitForUrl(command) {
  const tab = await getActiveTab();
  const pattern = command.url;
  const timeout = command.timeout || 30000;

  if (!pattern) throw new Error('URL pattern is required for waitforurl');

  const start = Date.now();
  while (Date.now() - start < timeout) {
    const current = await chrome.tabs.get(tab.id);
    if (urlMatches(current.url, pattern)) {
      return { id: command.id, success: true, data: { url: current.url } };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for URL matching: ${pattern}`);
}

export async function handleBringToFront(command) {
  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { id: command.id, success: true, data: { focused: true } };
}
