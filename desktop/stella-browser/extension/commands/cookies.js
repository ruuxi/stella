/**
 * Cookie command handlers.
 */
import { getActiveTab } from './tabs.js';

export async function handleCookiesGet(command) {
  const tab = await getActiveTab();
  const url = command.url || tab.url;

  if (!url || url.startsWith('chrome://')) {
    return {
      id: command.id,
      success: true,
      data: { cookies: [] },
    };
  }

  const cookies = await chrome.cookies.getAll({ url });

  // Optionally filter by name
  const filtered = command.name
    ? cookies.filter(c => c.name === command.name)
    : cookies;

  return {
    id: command.id,
    success: true,
    data: {
      cookies: filtered.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expirationDate || -1,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
    },
  };
}

export async function handleCookiesSet(command) {
  const tab = await getActiveTab();
  const url = command.url || tab.url;

  if (!url) throw new Error('URL is required for cookies_set');

  const cookie = {
    url: url,
    name: command.name,
    value: command.value,
    ...(command.domain && { domain: command.domain }),
    ...(command.path && { path: command.path }),
    ...(command.secure !== undefined && { secure: command.secure }),
    ...(command.httpOnly !== undefined && { httpOnly: command.httpOnly }),
    ...(command.sameSite && { sameSite: command.sameSite }),
    ...(command.expires && { expirationDate: command.expires }),
  };

  const result = await chrome.cookies.set(cookie);

  return {
    id: command.id,
    success: true,
    data: { cookie: result },
  };
}

export async function handleCookiesClear(command) {
  const tab = await getActiveTab();
  const url = command.url || tab.url;

  if (!url || url.startsWith('chrome://')) {
    return {
      id: command.id,
      success: true,
      data: { cleared: 0 },
    };
  }

  const cookies = await chrome.cookies.getAll({ url });

  let cleared = 0;
  for (const cookie of cookies) {
    // If name filter is specified, only clear matching cookies
    if (command.name && cookie.name !== command.name) continue;

    const cookieUrl =
      (cookie.secure ? 'https://' : 'http://') +
      cookie.domain.replace(/^\./, '') +
      cookie.path;

    await chrome.cookies.remove({ url: cookieUrl, name: cookie.name });
    cleared++;
  }

  return {
    id: command.id,
    success: true,
    data: { cleared },
  };
}
