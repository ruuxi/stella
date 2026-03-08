/**
 * Site Mods — Content script that auto-injects saved CSS/JS on page load.
 *
 * Runs at document_start on all pages. Reads saved modifications from
 * chrome.storage.local and injects matching CSS immediately (before first
 * paint) and JS after the DOM is ready.
 *
 * Storage key: "stella_site_mods"
 * Format: { [pattern]: { css?, js?, label?, enabled } }
 */

// ─── URL Pattern Matching ──────────────────────────────────────────────

/**
 * Convert a glob pattern to a RegExp.
 * e.g. "x.com/*" → /^x\.com\/.*$/i
 *      "*.github.com/*/pull/*" → /^.*\.github\.com\/.*\/pull\/.*$/i
 */
function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

/** hostname + pathname (no protocol/query/hash) */
function getMatchTarget(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return u.hostname + path;
  } catch {
    return null;
  }
}

// ─── Injection ─────────────────────────────────────────────────────────

function injectCSS(css, pattern) {
  const style = document.createElement('style');
  style.setAttribute('data-stella-mod', pattern);
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

function injectJS(js, pattern) {
  const script = document.createElement('script');
  script.setAttribute('data-stella-mod', pattern);
  script.textContent = js;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// ─── Apply / Remove ────────────────────────────────────────────────────

function removeAllMods() {
  document.querySelectorAll('[data-stella-mod]').forEach(el => el.remove());
}

async function applySiteMods() {
  const target = getMatchTarget(location.href);
  if (!target) return;

  let data;
  try {
    data = await chrome.storage.local.get('stella_site_mods');
  } catch {
    return; // extension context invalidated
  }

  const mods = data.stella_site_mods;
  if (!mods || typeof mods !== 'object') return;

  for (const [pattern, mod] of Object.entries(mods)) {
    if (!mod.enabled) continue;
    if (!patternToRegex(pattern).test(target)) continue;

    if (mod.css) {
      injectCSS(mod.css, pattern);
    }
    if (mod.js) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => injectJS(mod.js, pattern), { once: true });
      } else {
        injectJS(mod.js, pattern);
      }
    }
  }
}

// ─── SPA Navigation Detection ──────────────────────────────────────────

let lastUrl = location.href;

function onUrlChange() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  removeAllMods();
  applySiteMods();
}

// Hook pushState/replaceState by injecting into the page world.
// The page-world script dispatches a custom event that we listen for here
// in the content-script world.
function hookHistoryNavigation() {
  const hook = document.createElement('script');
  hook.textContent = `(function(){
    var orig_push = history.pushState;
    var orig_replace = history.replaceState;
    history.pushState = function(){
      orig_push.apply(this, arguments);
      window.dispatchEvent(new Event('stella:urlchange'));
    };
    history.replaceState = function(){
      orig_replace.apply(this, arguments);
      window.dispatchEvent(new Event('stella:urlchange'));
    };
  })();`;
  (document.head || document.documentElement).appendChild(hook);
  hook.remove();
}

window.addEventListener('stella:urlchange', onUrlChange);
window.addEventListener('popstate', () => setTimeout(onUrlChange, 0));

// ─── Live Reload ───────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.stella_site_mods) {
    removeAllMods();
    applySiteMods();
  }
});

// ─── Init ──────────────────────────────────────────────────────────────

applySiteMods();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', hookHistoryNavigation, { once: true });
} else {
  hookHistoryNavigation();
}
