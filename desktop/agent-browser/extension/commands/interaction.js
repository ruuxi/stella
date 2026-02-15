/**
 * DOM interaction command handlers.
 * Uses chrome.scripting.executeScript for most interactions,
 * chrome.debugger for keyboard input when more reliable handling is needed.
 */
import { getActiveTab } from './tabs.js';
import { resolveSelector, buildRoleMatcherScript } from '../lib/selector.js';
import { ensureDebugger } from '../lib/debugger.js';

/**
 * Inject a script that finds an element and runs code on it.
 * Uses CDP Runtime.evaluate to bypass CSP restrictions (no new Function/eval).
 */
async function injectScript(tabId, resolved, actionScript) {
  let script;
  if (resolved.isRef) {
    const finderScript = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);
    script = `
      (() => {
        const el = ${finderScript.trim()};
        if (!el) throw new Error('Element not found');
        ${actionScript}
      })()
    `;
  } else {
    script = `
      (() => {
        const el = document.querySelector(${JSON.stringify(resolved.css)});
        if (!el) throw new Error('Element not found: ${resolved.css}');
        ${actionScript}
      })()
    `;
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

// --- Command Handlers ---

export async function handleClick(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for click');

  const resolved = resolveSelector(selector);
  await injectScript(tab.id, resolved, `
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.click();
    return true;
  `);

  return { id: command.id, success: true, data: { clicked: true } };
}

export async function handleFill(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  const value = command.value ?? '';
  if (!selector) throw new Error('Selector is required for fill');

  const resolved = resolveSelector(selector);
  await injectScript(tab.id, resolved, `
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);

  return { id: command.id, success: true, data: { filled: true } };
}

export async function handleType(command) {
  const tab = await getActiveTab();
  const text = command.text || '';

  // If there's a selector, focus that element first
  if (command.selector || command.ref) {
    const resolved = resolveSelector(command.selector || command.ref);
    await injectScript(tab.id, resolved, `
      el.focus();
      return true;
    `);
  }

  // Use chrome.debugger for reliable key input
  await ensureDebugger(tab.id);
  for (const char of text) {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      key: char,
      code: 'Key' + char.toUpperCase(),
    });
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char,
      code: 'Key' + char.toUpperCase(),
    });
  }

  return { id: command.id, success: true, data: { typed: true } };
}

export async function handleHover(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for hover');

  const resolved = resolveSelector(selector);
  await injectScript(tab.id, resolved, `
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    return true;
  `);

  return { id: command.id, success: true, data: { hovered: true } };
}

export async function handleSelect(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  const values = command.values || [command.value];
  if (!selector) throw new Error('Selector is required for select');

  const resolved = resolveSelector(selector);
  await injectScript(tab.id, resolved, `
    const values = ${JSON.stringify(values)};
    for (const option of el.options) {
      option.selected = values.includes(option.value) || values.includes(option.textContent.trim());
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return Array.from(el.selectedOptions).map(o => o.value);
  `);

  return { id: command.id, success: true, data: { selected: values } };
}

export async function handlePress(command) {
  const tab = await getActiveTab();
  const key = command.key;
  if (!key) throw new Error('Key is required for press');

  // If there's a selector, focus that element first
  if (command.selector || command.ref) {
    const resolved = resolveSelector(command.selector || command.ref);
    await injectScript(tab.id, resolved, 'el.focus(); return true;');
  }

  await ensureDebugger(tab.id);

  // Parse modifier+key combos like "Control+a"
  const parts = key.split('+');
  const mainKey = parts.pop();
  const modifiers = parts.map(m => m.toLowerCase());

  let modifierFlags = 0;
  if (modifiers.includes('alt') || modifiers.includes('meta')) modifierFlags |= 1;
  if (modifiers.includes('control') || modifiers.includes('ctrl')) modifierFlags |= 2;
  if (modifiers.includes('meta') || modifiers.includes('command')) modifierFlags |= 4;
  if (modifiers.includes('shift')) modifierFlags |= 8;

  // Key down for modifiers
  for (const mod of modifiers) {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: mod.charAt(0).toUpperCase() + mod.slice(1),
      modifiers: modifierFlags,
    });
  }

  // Main key
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: mainKey,
    modifiers: modifierFlags,
  });
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: mainKey,
    modifiers: modifierFlags,
  });

  // Key up for modifiers (reverse order)
  for (const mod of [...modifiers].reverse()) {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: mod.charAt(0).toUpperCase() + mod.slice(1),
    });
  }

  return { id: command.id, success: true, data: { pressed: key } };
}

export async function handleScroll(command) {
  const tab = await getActiveTab();
  const x = command.x ?? 0;
  const y = command.y ?? 0;

  if (command.selector || command.ref) {
    const resolved = resolveSelector(command.selector || command.ref);
    await injectScript(tab.id, resolved, `
      el.scrollBy(${x}, ${y});
      return { scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
    `);
  } else {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (dx, dy) => {
        window.scrollBy(dx, dy);
        return { scrollX: window.scrollX, scrollY: window.scrollY };
      },
      args: [x, y],
    });
  }

  return { id: command.id, success: true, data: { scrolled: true } };
}

export async function handleClear(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for clear');

  const resolved = resolveSelector(selector);
  await injectScript(tab.id, resolved, `
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);

  return { id: command.id, success: true, data: { cleared: true } };
}

export async function handleCheck(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for check');

  const resolved = resolveSelector(selector);
  await injectScript(tab.id, resolved, `
    if (!el.checked) el.click();
    return el.checked;
  `);

  return { id: command.id, success: true, data: { checked: true } };
}

export async function handleUncheck(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for uncheck');

  const resolved = resolveSelector(selector);
  await injectScript(tab.id, resolved, `
    if (el.checked) el.click();
    return !el.checked;
  `);

  return { id: command.id, success: true, data: { unchecked: true } };
}

export async function handleFocus(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for focus');

  const resolved = resolveSelector(selector);
  await injectScript(tab.id, resolved, `
    el.focus();
    return true;
  `);

  return { id: command.id, success: true, data: { focused: true } };
}

export async function handleDblclick(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  if (!selector) throw new Error('Selector is required for dblclick');

  const resolved = resolveSelector(selector);
  await injectScript(tab.id, resolved, `
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return true;
  `);

  return { id: command.id, success: true, data: { dblclicked: true } };
}

export async function handleWait(command) {
  const tab = await getActiveTab();
  const selector = command.selector || command.ref;
  const timeout = command.timeout || 30000;

  if (!selector) {
    // Just wait for a duration
    await new Promise(r => setTimeout(r, timeout));
    return { id: command.id, success: true, data: { waited: true } };
  }

  const resolved = resolveSelector(selector);

  // Poll until element appears or timeout
  const startTime = Date.now();
  const pollInterval = 200;

  while (Date.now() - startTime < timeout) {
    try {
      if (resolved.isRef) {
        const script = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);
        await ensureDebugger(tab.id);
        const evalResult = await chrome.debugger.sendCommand(
          { tabId: tab.id }, 'Runtime.evaluate',
          { expression: `!!(${script.trim()})`, returnByValue: true }
        );
        if (evalResult.result?.value) {
          return { id: command.id, success: true, data: { waited: true, found: true } };
        }
      } else {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => !!document.querySelector(sel),
          args: [resolved.css],
        });
        if (result?.result) {
          return { id: command.id, success: true, data: { waited: true, found: true } };
        }
      }
    } catch {
      // Page might be navigating
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error(`Timeout waiting for selector: ${selector}`);
}

// --- Clipboard ---

export async function handleClipboard(command) {
  const tab = await getActiveTab();
  const operation = command.operation;
  if (!operation) throw new Error('Operation is required for clipboard (copy/paste/read)');

  switch (operation) {
    case 'copy': {
      await ensureDebugger(tab.id);
      // Ctrl+C
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Control', modifiers: 2,
      });
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'c', modifiers: 2,
      });
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'c', modifiers: 2,
      });
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Control',
      });
      return { id: command.id, success: true, data: { copied: true } };
    }
    case 'paste': {
      await ensureDebugger(tab.id);
      // Ctrl+V
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Control', modifiers: 2,
      });
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'v', modifiers: 2,
      });
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'v', modifiers: 2,
      });
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Control',
      });
      return { id: command.id, success: true, data: { pasted: true } };
    }
    case 'read': {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          try {
            return await navigator.clipboard.readText();
          } catch {
            return null;
          }
        },
        world: 'MAIN',
      });
      return { id: command.id, success: true, data: { text: result?.result ?? '' } };
    }
    default:
      throw new Error(`Unknown clipboard operation: ${operation}`);
  }
}

// --- Advanced Mouse Input (CDP) ---

export async function handleMouseMove(command) {
  const tab = await getActiveTab();
  const x = command.x ?? 0;
  const y = command.y ?? 0;

  await ensureDebugger(tab.id);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x, y,
  });

  return { id: command.id, success: true, data: { moved: true, x, y } };
}

export async function handleMouseDown(command) {
  const tab = await getActiveTab();
  const x = command.x ?? 0;
  const y = command.y ?? 0;
  const button = command.button || 'left';

  await ensureDebugger(tab.id);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x, y,
    button,
    clickCount: 1,
  });

  return { id: command.id, success: true, data: { pressed: true, x, y } };
}

export async function handleMouseUp(command) {
  const tab = await getActiveTab();
  const x = command.x ?? 0;
  const y = command.y ?? 0;
  const button = command.button || 'left';

  await ensureDebugger(tab.id);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x, y,
    button,
    clickCount: 1,
  });

  return { id: command.id, success: true, data: { released: true, x, y } };
}

export async function handleDrag(command) {
  const tab = await getActiveTab();
  const { startX, startY, endX, endY } = command;
  if (startX == null || startY == null || endX == null || endY == null) {
    throw new Error('startX, startY, endX, endY are required for drag');
  }

  await ensureDebugger(tab.id);

  // Mouse down at start
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1,
  });

  // Move in steps
  const steps = command.steps || 10;
  for (let i = 1; i <= steps; i++) {
    const x = startX + (endX - startX) * (i / steps);
    const y = startY + (endY - startY) * (i / steps);
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'left',
    });
  }

  // Mouse up at end
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: endX, y: endY, button: 'left', clickCount: 1,
  });

  return { id: command.id, success: true, data: { dragged: true } };
}

// --- Advanced Keyboard Input (CDP) ---

export async function handleKeyDown(command) {
  const tab = await getActiveTab();
  const key = command.key;
  if (!key) throw new Error('Key is required for keydown');

  await ensureDebugger(tab.id);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
  });

  return { id: command.id, success: true, data: { keydown: key } };
}

export async function handleKeyUp(command) {
  const tab = await getActiveTab();
  const key = command.key;
  if (!key) throw new Error('Key is required for keyup');

  await ensureDebugger(tab.id);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
  });

  return { id: command.id, success: true, data: { keyup: key } };
}

export async function handleInsertText(command) {
  const tab = await getActiveTab();
  const text = command.text;
  if (text == null) throw new Error('Text is required for inserttext');

  await ensureDebugger(tab.id);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.insertText', {
    text,
  });

  return { id: command.id, success: true, data: { inserted: true } };
}
