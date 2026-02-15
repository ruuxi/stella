/**
 * Selector resolution for element targeting.
 * Supports ref-based selectors (@e1, e1) and CSS selectors.
 */

// Current ref map, updated after each snapshot
let refMap = {};

/**
 * Update the ref map (called after snapshot).
 * @param {Record<string, {selector: string, role: string, name?: string, nth?: number}>} refs
 */
export function setRefMap(refs) {
  refMap = refs;
}

/**
 * Get the current ref map.
 */
export function getRefMap() {
  return refMap;
}

/**
 * Check if a string is a ref selector.
 * @param {string} selector
 * @returns {boolean}
 */
export function isRef(selector) {
  if (selector.startsWith('@')) return true;
  if (selector.startsWith('ref=')) return true;
  if (/^e\d+$/.test(selector)) return true;
  return false;
}

/**
 * Parse a ref string to its key (e.g., "@e1" -> "e1", "ref=e3" -> "e3").
 * @param {string} selector
 * @returns {string|null}
 */
export function parseRef(selector) {
  if (selector.startsWith('@')) return selector.slice(1);
  if (selector.startsWith('ref=')) return selector.slice(4);
  if (/^e\d+$/.test(selector)) return selector;
  return null;
}

/**
 * Resolve a selector (ref or CSS) to a CSS selector that can be used with querySelector.
 * For refs, also returns role/name info for getByRole-style matching.
 *
 * @param {string} selector
 * @returns {{ css: string|null, role?: string, name?: string, nth?: number, isRef: boolean }}
 */
export function resolveSelector(selector) {
  const ref = parseRef(selector);
  if (ref) {
    const data = refMap[ref];
    if (!data) {
      throw new Error(`Unknown ref: ${ref}. Run 'snapshot' first to generate refs.`);
    }
    return {
      css: null, // Use role-based matching instead
      role: data.role,
      name: data.name,
      nth: data.nth,
      isRef: true,
    };
  }

  // Plain CSS selector
  return { css: selector, isRef: false };
}

/**
 * Build an injectable script that finds an element by role+name (like Playwright's getByRole).
 * Returns a function body string to be used with chrome.scripting.executeScript.
 *
 * @param {string} role
 * @param {string} [name]
 * @param {number} [nth]
 * @returns {string} - JS code that returns the matched element or throws
 */
export function buildRoleMatcherScript(role, name, nth) {
  // This script runs in the page context
  return `
    (() => {
      const ROLE_TAG_MAP = {
        button: ['button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]', '[role="button"]'],
        link: ['a[href]', '[role="link"]'],
        textbox: ['input:not([type])', 'input[type="text"]', 'input[type="email"]', 'input[type="password"]', 'input[type="search"]', 'input[type="tel"]', 'input[type="url"]', 'input[type="number"]', 'textarea', '[role="textbox"]', '[contenteditable="true"]'],
        checkbox: ['input[type="checkbox"]', '[role="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]'],
        combobox: ['select', '[role="combobox"]'],
        listbox: ['select[multiple]', '[role="listbox"]'],
        menuitem: ['[role="menuitem"]'],
        option: ['option', '[role="option"]'],
        searchbox: ['input[type="search"]', '[role="searchbox"]'],
        slider: ['input[type="range"]', '[role="slider"]'],
        spinbutton: ['input[type="number"]', '[role="spinbutton"]'],
        switch: ['[role="switch"]'],
        tab: ['[role="tab"]'],
        treeitem: ['[role="treeitem"]'],
        heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]'],
        img: ['img[alt]', '[role="img"]'],
        cell: ['td', '[role="cell"]', '[role="gridcell"]'],
        row: ['tr', '[role="row"]'],
        navigation: ['nav', '[role="navigation"]'],
        main: ['main', '[role="main"]'],
        region: ['section[aria-label]', '[role="region"]'],
        article: ['article', '[role="article"]'],
        clickable: ['[onclick]', '[tabindex]:not([tabindex="-1"])'],
        focusable: ['[tabindex]:not([tabindex="-1"])'],
      };

      const role = ${JSON.stringify(role)};
      const name = ${name != null ? JSON.stringify(name) : 'null'};
      const nth = ${nth != null ? nth : 'null'};

      const selectors = ROLE_TAG_MAP[role] || ['[role="' + role + '"]'];
      const candidates = [];

      for (const sel of selectors) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
          // Skip hidden elements
          if (el.offsetParent === null && el.tagName !== 'BODY') continue;

          candidates.push(el);
        }
      }

      // Filter by name if provided
      let matches = candidates;
      if (name !== null) {
        matches = candidates.filter(el => {
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel === name) return true;

          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl && labelEl.textContent.trim() === name) return true;
          }

          const text = (el.textContent || '').trim();
          if (text === name) return true;

          // For inputs, check placeholder and title
          if (el.placeholder === name) return true;
          if (el.title === name) return true;

          // For inputs with associated label
          if (el.id) {
            const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (label && label.textContent.trim() === name) return true;
          }

          // Value attribute for buttons
          if (el.value === name && (el.type === 'button' || el.type === 'submit')) return true;

          // Alt text for images
          if (el.alt === name) return true;

          return false;
        });
      }

      if (matches.length === 0) {
        throw new Error('No element found with role="' + role + '"' + (name ? ' name="' + name + '"' : ''));
      }

      const index = nth ?? 0;
      if (index >= matches.length) {
        throw new Error('Element index ' + index + ' out of range, found ' + matches.length + ' matches');
      }

      return matches[index];
    })()
  `;
}
