/**
 * Site Mods Store — JSON file-based persistence for per-site CSS/JS overrides.
 *
 * Used by the daemon in Playwright/CDP mode (Electron apps, headless browsers).
 * Extension mode uses chrome.storage.local instead (see extension/commands/site-mods.js).
 *
 * Storage: ../.stella/stella-browser/site-mods.json in repo/dev mode
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getAppDir } from './runtime-paths.js';

export interface SiteMod {
  css: string | null;
  js: string | null;
  label: string | null;
  enabled: boolean;
  updatedAt: number;
}

export type SiteModsMap = Record<string, SiteMod>;

function getStorePath(): string {
  const dir = getAppDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'site-mods.json');
}

export function getMods(): SiteModsMap {
  const filePath = getStorePath();
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveMods(mods: SiteModsMap): void {
  writeFileSync(getStorePath(), JSON.stringify(mods, null, 2), 'utf-8');
}

export function setMod(
  pattern: string,
  update: { css?: string; js?: string; label?: string },
): { mod: SiteMod; total: number } {
  const mods = getMods();
  const existing = mods[pattern] || {};

  const mod: SiteMod = {
    css: update.css !== undefined ? update.css : (existing.css ?? null),
    js: update.js !== undefined ? update.js : (existing.js ?? null),
    label: update.label !== undefined ? update.label : (existing.label ?? null),
    enabled: true,
    updatedAt: Date.now(),
  };

  mods[pattern] = mod;
  saveMods(mods);
  return { mod, total: Object.keys(mods).length };
}

export function removeMod(pattern: string): { removed: boolean; total: number } {
  const mods = getMods();
  const existed = pattern in mods;
  delete mods[pattern];
  saveMods(mods);
  return { removed: existed, total: Object.keys(mods).length };
}

export function toggleMod(pattern: string, enabled?: boolean): { enabled: boolean } {
  const mods = getMods();
  if (!(pattern in mods)) throw new Error(`No site mod found for pattern: ${pattern}`);
  mods[pattern].enabled = enabled !== undefined ? enabled : !mods[pattern].enabled;
  mods[pattern].updatedAt = Date.now();
  saveMods(mods);
  return { enabled: mods[pattern].enabled };
}

/** Convert a glob pattern to a RegExp. */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

/** Get hostname + pathname from a URL (no protocol/query/hash). */
function getMatchTarget(url: string): string | null {
  try {
    const u = new URL(url);
    const p = u.pathname === '/' ? '' : u.pathname;
    return u.hostname + p;
  } catch {
    return null;
  }
}

/** Return all enabled mods whose pattern matches the given URL. */
export function getMatchingMods(url: string): Array<{ pattern: string } & SiteMod> {
  const target = getMatchTarget(url);
  if (!target) return [];

  const mods = getMods();
  const matches: Array<{ pattern: string } & SiteMod> = [];

  for (const [pattern, mod] of Object.entries(mods)) {
    if (!mod.enabled) continue;
    if (patternToRegex(pattern).test(target)) {
      matches.push({ pattern, ...mod });
    }
  }

  return matches;
}
