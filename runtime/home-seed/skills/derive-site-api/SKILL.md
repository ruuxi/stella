---
name: derive-site-api
description: Turn a website into a direct API client by recording its own network traffic once, then calling those endpoints instead of re-driving the browser. Use when a site has no public API and the user wants repeatable, fast access to it.
---

# Site client forge

Most websites are a thin frontend over a private JSON API. Driving that frontend
with a browser works but is slow, fragile, and costs a page render per action.
Recording the traffic once reveals the API underneath, and from then on the same
task is a direct HTTP call.

Use this skill when the user wants repeated or programmatic access to a site
that offers no public API. For a genuinely one-off action, just drive the
browser — forging a client is only worth it if it will be reused.

## The session is the auth

Never copy a captured `Cookie` header, bearer token, or CSRF value into
generated code. Those are live credentials: they expire, they differ per user,
and writing them to disk leaks them.

Instead, make calls **from the site's own origin** using `evaluate`. The browser
attaches the session automatically, exactly as it does for the real page, so the
client needs no credential handling at all. This is also why the recorder never
exposes cookies to you — it does not need to.

## 1. Record

Open a tab, start recording, then drive the flow you want to reproduce. Record
the *shortest path* that produces the data — extra browsing adds noise.

```js
var tab = await browser.tabs.new("https://example.com/orders");
await browser.chain([{ action: "har_start", params: { tabId: tab.id } }]);

// Drive the actual flow. Use whatever interaction the task needs.
var page = tab.playwright;
await page.getByRole("button", { name: "My orders" }).click();
await page.locator("[data-testid='order-row']").first().waitFor({ state: "visible" });
```

If the flow needs a login the user must perform themselves, say so and let them
sign in in that tab before you start recording. Do not type credentials.

Then stop, and write the HAR to disk. It is far too large to read directly —
step 2 exists precisely so it never enters your context.

`har_stop` returns one of two shapes depending on which browser backend is
attached, so handle both: the extension returns the log inline, while Stella's
own browser writes a file and returns its path.

```js
var fs = require("node:fs");
var path = require("node:path");

var stopped = await browser.chain([{ action: "har_stop", params: { tabId: tab.id } }]);
var data = stopped.results[0].data;

var harPath;
if (data.log) {
  harPath = path.join(nodeRepl.tmp, "example-com.har.json");
  fs.writeFileSync(harPath, JSON.stringify(data));
} else {
  harPath = data.path; // already on disk
}
({ requests: data.requestCount, bodies: data.bodiesCaptured, harPath });
```

Check `bodiesCaptured` before continuing. If it is 0 or absent, the analyzer
will have no response shapes to report. Two causes:

- The recording started after the traffic. Response bodies can only be read
  while a recording is open, so re-record with `har_start` first.
- The attached backend is Stella's own browser, which does not capture response
  bodies. It also has none of the user's sessions, so a client forged there
  would be unauthenticated anyway — record through the user's browser instead.

## 2. Reduce

Never read the HAR yourself. Run the analyzer, which drops analytics and static
assets, collapses repeated calls into path templates, infers request and
response shapes, and redacts credentials and personal fields:

```bash
bun ~/.stella/skills/derive-site-api/scripts/program.ts <har> --out <report.md>
```

Read the report. It also accepts `--json <path>` for a machine-readable surface
and `--max-endpoints N` (default 60) when the site is large.

Pick the smallest set of endpoints that covers the user's task. A good client
wraps two or three operations well rather than every endpoint discovered.

## 3. Validate before writing anything

Confirm each endpoint works as a direct call, from the page origin, before you
build on it:

```js
var probe = await page.evaluate(`
  fetch("/api/v2/orders?limit=5", { headers: { accept: "application/json" } })
    .then(async (response) => ({
      status: response.status,
      body: (await response.text()).slice(0, 2000),
    }))
`);
```

Return the status and a slice of the body — never the whole response. If it
returns 401/403, the endpoint needs a header the page sets itself; look for it
in the report's Authentication section and read the live value from the page
(`localStorage`, a meta tag, a bootstrap response) rather than reusing the
recorded one.

## 4. Write the client as its own skill

Create `~/.stella/skills/<site>-client/` with a `SKILL.md` and, when there is
real logic, `scripts/program.ts`. The SKILL.md must record:

- Which operations are covered, with their exact paths and parameters.
- That calls run from the site's origin via `evaluate`, and why.
- Any header the page supplies, and **where to read it live**.
- The date recorded and the site version if one is visible, so a later reader
  knows how stale it might be.

Keep the derived client small and specific. Its value is that it does one thing
reliably without a browser render, not that it mirrors the whole site.

## 5. When it breaks

A private API changes without warning. Treat a client that starts returning
401/403, 404, or an unexpected shape as a signal to re-record rather than to
patch blindly: repeat steps 1–3 and diff the new report against the client's
documented endpoints. Recording is cheap; guessing at a moved endpoint is not.

Tell the user what changed and what you updated. If the site has started
rejecting non-browser requests outright — a challenge page, or a signature
header you cannot reproduce from the page — say so plainly and fall back to
driving the browser. Do not attempt to defeat bot protection.
