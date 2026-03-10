---
id: browser-patterns
name: Browser Common Patterns
description: Common Playwright patterns for popups, downloads, iframes, dialogs, file loading, and network interception.
agentTypes:
  - browser
tags:
  - browser
  - patterns
  - playwright
version: 1
---

# Browser Common Patterns

## Popups
Capture before triggering:

```js
const [popup] = await Promise.all([
  page.waitForEvent('popup'),
  page.click('a[target=_blank]'),
]);
await popup.waitForLoadState();
console.log('Popup URL:', popup.url());
```

## Downloads
Capture and save:

```js
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('button.download'),
]);
await download.saveAs(`/tmp/${download.suggestedFilename()}`);
```

## iFrames
Use `frameLocator`:

```js
const frame = page.frameLocator('#my-iframe');
await frame.locator('button').click();
```

## Dialogs
Handle alerts, confirms, and prompts:

```js
page.on('dialog', async dialog => {
  console.log(dialog.message());
  await dialog.accept();
});
await page.click('button.trigger-alert');
```

## Loading Files
Fill inputs with file content:

```js
const fs = require('node:fs');
const content = fs.readFileSync('./data.txt', 'utf-8');
await page.locator('textarea').fill(content);
```

## Network Interception
Intercept requests instead of scrolling the DOM:

```js
state.requests = [];
state.responses = [];
page.on('request', req => {
  if (req.url().includes('/api/')) {
    const headers = req.headers();
    const authHeader = headers['authorization'];
    const cookieHeader = headers['cookie'];
    state.requests.push({
      url: req.url(),
      method: req.method(),
      authMeta: {
        hasAuthorization: Boolean(authHeader),
        authorizationScheme: authHeader ? authHeader.split(' ')[0] : null,
        hasCookie: Boolean(cookieHeader),
        cookieNames: cookieHeader
          ? cookieHeader.split(';').map((pair) => pair.split('=')[0]?.trim()).filter(Boolean)
          : [],
      },
      contentType: headers['content-type'] ?? null,
    });
  }
});
page.on('response', async res => {
  if (res.url().includes('/api/')) {
    try {
      state.responses.push({ url: res.url(), status: res.status(), body: await res.json() });
    } catch {}
  }
});
```

Analyze captured data:

```js
console.log('Captured', state.responses.length, 'API calls');
state.responses.forEach(r => console.log(r.status, r.url.slice(0, 80)));
```

Replay an API directly:

```js
const { url } = state.requests.find(r => r.url.includes('feed'));
const data = await page.evaluate(async ({ url }) => {
  const res = await fetch(url);
  return res.json();
}, { url });
```

Clean up:

```js
page.removeAllListeners('request');
page.removeAllListeners('response');
```
