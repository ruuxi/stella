/**
 * Site Mods command handlers.
 *
 * Persistent per-site CSS/JS overrides stored in chrome.storage.local
 * under key "stella_site_mods".
 *
 * The site-mods.js content script is registered dynamically (not in the
 * manifest) so it only runs on pages that actually have saved mods.
 */

const STORAGE_KEY = 'stella_site_mods';
const CONTENT_SCRIPT_ID = 'stella-site-mods';

async function getMods() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function saveMods(mods) {
  await chrome.storage.local.set({ [STORAGE_KEY]: mods });
  await syncContentScriptRegistration(mods);
}

/**
 * Convert a site-mod glob pattern (e.g. "x.com/*") to a Chrome match pattern
 * (e.g. "*://x.com/*") suitable for chrome.scripting.registerContentScripts.
 */
function globToMatchPattern(pattern) {
  // Already has a scheme — use as-is
  if (/^[a-z]+:\/\//.test(pattern)) {
    return pattern;
  }
  // Ensure trailing wildcard for bare hostnames
  const p = pattern.includes('/') ? pattern : pattern + '/*';
  return `*://${p}`;
}

/**
 * Sync the dynamically registered site-mods.js content script so it only
 * runs on pages that have at least one enabled mod.
 */
export async function syncContentScriptRegistration(mods) {
  if (!mods) {
    mods = await getMods();
  }

  const enabledPatterns = Object.entries(mods)
    .filter(([, mod]) => mod.enabled)
    .map(([pattern]) => globToMatchPattern(pattern));

  try {
    if (enabledPatterns.length === 0) {
      // No enabled mods — unregister the content script
      await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
      return;
    }

    // Try to update existing registration first
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    if (existing.length > 0) {
      await chrome.scripting.updateContentScripts([{
        id: CONTENT_SCRIPT_ID,
        matches: enabledPatterns,
      }]);
    } else {
      await chrome.scripting.registerContentScripts([{
        id: CONTENT_SCRIPT_ID,
        matches: enabledPatterns,
        js: ['site-mods.js'],
        runAt: 'document_start',
      }]);
    }
  } catch (err) {
    console.warn('[site-mods] Failed to sync content script registration:', err);
  }
}

/**
 * site_mod_set - Save or update a per-site override.
 *
 * Required: pattern (URL glob, e.g. "x.com/*")
 * Optional: css, js, label
 * If the pattern already exists, fields are merged (so you can add JS to
 * an existing CSS-only rule without re-specifying the CSS).
 */
export async function handleSiteModSet(command) {
  const { pattern, css, js, label } = command;
  if (!pattern) throw new Error('pattern is required for site_mod_set');
  if (!css && !js) throw new Error('At least one of css or js is required');

  const mods = await getMods();
  const existing = mods[pattern] || {};

  mods[pattern] = {
    css: css !== undefined ? css : (existing.css || null),
    js: js !== undefined ? js : (existing.js || null),
    label: label !== undefined ? label : (existing.label || null),
    enabled: true,
    updatedAt: Date.now(),
  };

  await saveMods(mods);

  return {
    id: command.id,
    success: true,
    data: { pattern, mod: mods[pattern], total: Object.keys(mods).length },
  };
}

/**
 * site_mod_list - List all saved overrides.
 */
export async function handleSiteModList(command) {
  const mods = await getMods();

  const rules = Object.entries(mods).map(([pattern, mod]) => ({
    pattern,
    label: mod.label || null,
    hasCSS: !!mod.css,
    hasJS: !!mod.js,
    enabled: mod.enabled,
    updatedAt: mod.updatedAt || null,
  }));

  return {
    id: command.id,
    success: true,
    data: { rules, total: rules.length },
  };
}

/**
 * site_mod_remove - Delete an override by pattern.
 */
export async function handleSiteModRemove(command) {
  const { pattern } = command;
  if (!pattern) throw new Error('pattern is required for site_mod_remove');

  const mods = await getMods();
  const existed = pattern in mods;
  delete mods[pattern];
  await saveMods(mods);

  return {
    id: command.id,
    success: true,
    data: { pattern, removed: existed, total: Object.keys(mods).length },
  };
}

/**
 * site_mod_toggle - Enable or disable an override without deleting it.
 */
export async function handleSiteModToggle(command) {
  const { pattern, enabled } = command;
  if (!pattern) throw new Error('pattern is required for site_mod_toggle');

  const mods = await getMods();
  if (!(pattern in mods)) throw new Error(`No site mod found for pattern: ${pattern}`);

  mods[pattern].enabled = enabled !== undefined ? enabled : !mods[pattern].enabled;
  mods[pattern].updatedAt = Date.now();
  await saveMods(mods);

  return {
    id: command.id,
    success: true,
    data: { pattern, enabled: mods[pattern].enabled },
  };
}
