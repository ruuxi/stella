---
id: browser-advanced-tools
name: Browser Advanced Tools
description: Utility functions such as getCleanHTML, createDebugger, createEditor, getLatestLogs, getReactSource, getStylesForLocator, and response body reading.
agentTypes:
  - browser
tags:
  - browser
  - debugging
  - utilities
version: 1
---

# Browser Advanced Tools

## getLatestLogs
Retrieve captured browser console logs:

```js
await getLatestLogs({ page?, count?, search? });
const errors = await getLatestLogs({ search: /error/i, count: 50 });
```

For custom collection:

```js
state.logs = [];
page.on('console', m => state.logs.push(m.text()));
```

## getCleanHTML
Get cleaned HTML from a locator or page:

```js
await getCleanHTML({ locator, search?, showDiffSinceLastCall?, includeStyles? });
const html = await getCleanHTML({ locator: page.locator('body') });
const diff = await getCleanHTML({ locator: page, showDiffSinceLastCall: true });
```

## waitForPageLoad
Smart load detection that ignores analytics and ads:

```js
await waitForPageLoad({ page, timeout?, pollInterval?, minWait? });
```

## getCDPSession
Send raw Chrome DevTools Protocol commands:

```js
const cdp = await getCDPSession({ page });
const metrics = await cdp.send('Page.getLayoutMetrics');
```

## getLocatorStringForElement
Get a stable selector from an ephemeral aria-ref:

```js
const selector = await getLocatorStringForElement(page.locator('aria-ref=e14'));
```

## getReactSource
Get React component source location in dev mode:

```js
const source = await getReactSource({ locator: page.locator('aria-ref=e5') });
```

## getStylesForLocator
Inspect CSS styles applied to an element:

```js
const styles = await getStylesForLocator({
  locator: page.locator('.btn'),
  cdp: await getCDPSession({ page }),
});
console.log(formatStylesAsText(styles));
```

## createDebugger
Set breakpoints, step through code, and inspect variables:

```js
const cdp = await getCDPSession({ page });
const dbg = createDebugger({ cdp });
await dbg.enable();
const scripts = await dbg.listScripts({ search: 'app' });
await dbg.setBreakpoint({ file: scripts[0].url, line: 42 });
```

## createEditor
View and live-edit page scripts and CSS at runtime:

```js
const cdp = await getCDPSession({ page });
const editor = createEditor({ cdp });
await editor.enable();
const matches = await editor.grep({ regex: /console\.log/ });
await editor.edit({
  url: matches[0].url,
  oldString: 'DEBUG = false',
  newString: 'DEBUG = true',
});
```

## Reading Response Bodies
If response body buffering is disabled for SSE, re-enable it when needed:

```js
const cdp = await getCDPSession({ page });
await cdp.send('Network.disable');
await cdp.send('Network.enable', {
  maxTotalBufferSize: 10000000,
  maxResourceBufferSize: 5000000,
});

const [response] = await Promise.all([
  page.waitForResponse(resp => resp.url().includes('/api/data')),
  page.click('button.load-data'),
]);
const body = await response.text();
```

## Debugging stella-browser Issues
Read relay server logs:

```bash
stella-browser logfile
```
