/**
 * Selector resolution for element targeting.
 * Supports ref-based selectors (@e1, e1), structured semantic selectors, and CSS.
 */

// Snapshot refs are scoped to the logical command owner and tab.
const refMaps = new Map();
const SEMANTIC_SELECTOR_PREFIX = 'aria=';
const MAX_SEMANTIC_SELECTOR_LENGTH = 8192;
const MAX_SEMANTIC_VALUE_LENGTH = 1024;
const MAX_SEMANTIC_ROLE_LENGTH = 128;
const MAX_SEMANTIC_NTH = 10000;
const SEMANTIC_KINDS = new Set(['role', 'text', 'label', 'placeholder', 'testid']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireBoundedString(value, field, maxLength, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Semantic selector field '${field}' must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`Semantic selector field '${field}' exceeds ${maxLength} characters`);
  }
  return value;
}

function normalizeSemanticSelector(value) {
  if (!isPlainObject(value)) {
    throw new Error('Semantic selector payload must be a JSON object');
  }

  const kind = requireBoundedString(value.kind, 'kind', 32);
  if (!SEMANTIC_KINDS.has(kind)) {
    throw new Error(`Unsupported semantic selector kind: ${kind}`);
  }

  const allowedKeys = new Set(
    kind === 'role'
      ? ['kind', 'role', 'name', 'nth', 'exact']
      : ['kind', 'value', 'nth', 'exact'],
  );
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown semantic selector field '${key}' for kind '${kind}'`);
    }
  }

  if (value.nth !== undefined) {
    if (!Number.isInteger(value.nth) || value.nth < 0 || value.nth > MAX_SEMANTIC_NTH) {
      throw new Error(
        `Semantic selector field 'nth' must be an integer from 0 to ${MAX_SEMANTIC_NTH}`,
      );
    }
  }
  if (value.exact !== undefined && typeof value.exact !== 'boolean') {
    throw new Error("Semantic selector field 'exact' must be a boolean");
  }

  if (kind === 'role') {
    const role = requireBoundedString(value.role, 'role', MAX_SEMANTIC_ROLE_LENGTH);
    if (!/^[a-z][a-z0-9-]*$/.test(role)) {
      throw new Error("Semantic selector field 'role' has an invalid format");
    }
    return {
      kind,
      role,
      name: requireBoundedString(value.name, 'name', MAX_SEMANTIC_VALUE_LENGTH, {
        optional: true,
      }),
      nth: value.nth,
      exact: value.exact === true,
    };
  }

  return {
    kind,
    value: requireBoundedString(value.value, 'value', MAX_SEMANTIC_VALUE_LENGTH),
    nth: value.nth,
    exact: value.exact === true,
  };
}

export function encodeSemanticSelector(value) {
  const normalized = normalizeSemanticSelector(value);
  const selector = `${SEMANTIC_SELECTOR_PREFIX}${encodeURIComponent(JSON.stringify(normalized))}`;
  if (selector.length > MAX_SEMANTIC_SELECTOR_LENGTH) {
    throw new Error(
      `Semantic selector exceeds the ${MAX_SEMANTIC_SELECTOR_LENGTH} character limit`,
    );
  }
  return selector;
}

export function parseSemanticSelector(selector) {
  if (typeof selector !== 'string' || !selector.startsWith(SEMANTIC_SELECTOR_PREFIX)) {
    return null;
  }
  if (selector.length > MAX_SEMANTIC_SELECTOR_LENGTH) {
    throw new Error(
      `Semantic selector exceeds the ${MAX_SEMANTIC_SELECTOR_LENGTH} character limit`,
    );
  }

  const encoded = selector.slice(SEMANTIC_SELECTOR_PREFIX.length);
  if (!encoded) throw new Error('Semantic selector payload is empty');

  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new Error('Semantic selector payload is not valid percent-encoding');
  }

  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error('Semantic selector payload is not valid JSON');
  }
  return normalizeSemanticSelector(parsed);
}

function normalizeOwnerId(ownerId) {
  if (typeof ownerId !== 'string') return 'default';
  const trimmed = ownerId.trim();
  return trimmed || 'default';
}

function getOwnerRefMap(ownerId, createIfMissing = false) {
  const normalized = normalizeOwnerId(ownerId);
  if (!refMaps.has(normalized) && createIfMissing) {
    refMaps.set(normalized, new Map());
  }
  return refMaps.get(normalized);
}

/**
 * Update the ref map (called after snapshot).
 * @param {string} ownerId
 * @param {number} tabId
 * @param {Record<string, {selector: string, role: string, name?: string, nth?: number}>} refs
 */
export function setRefMap(ownerId, tabId, refs) {
  if (!Number.isInteger(tabId)) return;
  const ownerMap = getOwnerRefMap(ownerId, true);
  ownerMap.set(tabId, refs || {});
}

/**
 * Get the current ref map.
 */
export function getRefMap(ownerId, tabId) {
  if (!Number.isInteger(tabId)) return {};
  return getOwnerRefMap(ownerId)?.get(tabId) || {};
}

/**
 * Clear refs for a single owner.
 */
export function clearOwnerRefMaps(ownerId) {
  if (ownerId === undefined) {
    refMaps.clear();
    return;
  }
  refMaps.delete(normalizeOwnerId(ownerId));
}

/**
 * Clear refs for a single owner/tab pair.
 */
export function clearTabRefMap(ownerId, tabId) {
  if (!Number.isInteger(tabId)) return;
  const ownerMap = getOwnerRefMap(ownerId);
  if (!ownerMap) return;
  ownerMap.delete(tabId);
  if (ownerMap.size === 0) {
    refMaps.delete(normalizeOwnerId(ownerId));
  }
}

/**
 * Check if a string is a ref selector.
 * @param {string} selector
 * @returns {boolean}
 */
export function isRef(selector) {
  if (typeof selector !== 'string') return false;
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
  if (typeof selector !== 'string') return null;
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
 * @param {string} ownerId
 * @param {number} tabId
 * @returns {{ css: string|null, role?: string, name?: string, nth?: number, isRef: boolean }}
 */
export function resolveSelector(selector, ownerId, tabId) {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new Error('Selector must be a non-empty string');
  }

  const semantic = parseSemanticSelector(selector);
  if (semantic) {
    return {
      css: null,
      role: semantic,
      name: undefined,
      nth: semantic.nth,
      isRef: true,
      isSemantic: true,
    };
  }

  const ref = parseRef(selector);
  if (ref) {
    const refMap = getRefMap(ownerId, tabId);
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
function normalizeRoleMatcher(role, name, nth) {
  return isPlainObject(role) && SEMANTIC_KINDS.has(role.kind)
    ? normalizeSemanticSelector(role)
    : { kind: 'role', role, name, nth, exact: true };
}

/**
 * Build page-context JS that returns every element matching a semantic locator.
 */
export function buildRoleMatcherAllScript(role, name) {
  const matcher =
    normalizeRoleMatcher(role, name, undefined);

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

      const matcher = ${JSON.stringify(matcher)};
      const normalize = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const stringMatches = (actual, expected) => {
        const actualValue = normalize(actual);
        const expectedValue = normalize(expected);
        return matcher.exact
          ? actualValue === expectedValue
          : actualValue.toLocaleLowerCase().includes(expectedValue.toLocaleLowerCase());
      };
      const isVisible = el =>
        el.tagName === 'BODY' || el.getClientRects().length > 0;
      const uniqueVisible = elements =>
        [...new Set(elements)].filter(isVisible);
      const labelledText = el => {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (!labelledBy) return '';
        return labelledBy
          .split(/\\s+/)
          .map(id => document.getElementById(id)?.textContent || '')
          .join(' ');
      };
      const accessibleName = el => {
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;
        const labelled = labelledText(el);
        if (labelled) return labelled;
        if (el.id) {
          const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (label) return label.textContent || '';
        }
        return el.alt || el.value || el.title || el.placeholder || el.textContent || '';
      };

      let matches = [];
      if (matcher.kind === 'role') {
        const selectors = ROLE_TAG_MAP[matcher.role] || ['[role="' + matcher.role + '"]'];
        const candidates = uniqueVisible(
          selectors.flatMap(sel => [...document.querySelectorAll(sel)]),
        );
        matches = matcher.name === undefined
          ? candidates
          : candidates.filter(el => stringMatches(accessibleName(el), matcher.name));
      } else if (matcher.kind === 'text') {
        const candidates = uniqueVisible(document.querySelectorAll('body *'));
        matches = candidates.filter(el => {
          if (!stringMatches(el.textContent, matcher.value)) return false;
          return ![...el.children].some(
            child => isVisible(child) && stringMatches(child.textContent, matcher.value),
          );
        });
      } else if (matcher.kind === 'label') {
        const controls = [];
        for (const label of document.querySelectorAll('label')) {
          if (!stringMatches(label.textContent, matcher.value)) continue;
          const control = label.control || label.querySelector('input, textarea, select, button');
          if (control) controls.push(control);
        }
        for (const el of document.querySelectorAll('[aria-label], [aria-labelledby]')) {
          if (stringMatches(accessibleName(el), matcher.value)) controls.push(el);
        }
        matches = uniqueVisible(controls);
      } else if (matcher.kind === 'placeholder') {
        matches = uniqueVisible(document.querySelectorAll('[placeholder]'))
          .filter(el => stringMatches(el.getAttribute('placeholder'), matcher.value));
      } else if (matcher.kind === 'testid') {
        matches = uniqueVisible(document.querySelectorAll('[data-testid]'))
          .filter(el => stringMatches(el.getAttribute('data-testid'), matcher.value));
      }

      return matches;
    })()
  `;
}

/**
 * Build page-context JS that returns one semantic match or throws.
 */
export function buildRoleMatcherScript(role, name, nth) {
  const matcher = normalizeRoleMatcher(role, name, nth);
  const allMatches = buildRoleMatcherAllScript(matcher);
  const description =
    matcher.kind === 'role'
      ? `role=${JSON.stringify(matcher.role)}${
          matcher.name !== undefined ? ` name=${JSON.stringify(matcher.name)}` : ''
        }`
      : `${matcher.kind}=${JSON.stringify(matcher.value)}`;

  return `
    (() => {
      const matches = ${allMatches.trim()};
      if (matches.length === 0) {
        throw new Error(${JSON.stringify(`No element found with ${description}`)});
      }
      const index = ${matcher.nth ?? 0};
      if (index >= matches.length) {
        throw new Error('Element index ' + index + ' out of range, found ' + matches.length + ' matches');
      }
      return matches[index];
    })()
  `;
}
