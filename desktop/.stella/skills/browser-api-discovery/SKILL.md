---
id: browser-api-discovery
name: API Discovery Mode
description: Network interception, API reverse engineering, session token extraction, and structured output format for API mapping.
agentTypes:
  - browser
tags:
  - api
  - network
  - discovery
version: 1
---

# API Discovery Mode

When asked to investigate or reverse-engineer a web service's API.

## Process
1. Navigate to the service's web app and prefer the user's existing browser session when possible.
2. Enable network interception to capture API calls:

```javascript
state.apiCalls = [];
await page.route('**/*', async route => {
  const req = route.request();
  if (req.resourceType() === 'fetch' || req.resourceType() === 'xhr') {
    const headers = req.headers();
    const authHeader = headers['authorization'];
    const cookieHeader = headers['cookie'];
    state.apiCalls.push({
      url: req.url(),
      method: req.method(),
      authMeta: {
        hasAuthorization: Boolean(authHeader),
        authorizationScheme: authHeader ? authHeader.split(' ')[0] : null,
        hasCookie: Boolean(cookieHeader),
        cookieNames: cookieHeader
          ? cookieHeader.split(';').map((pair) => pair.split('=')[0]?.trim()).filter(Boolean)
          : [],
        hasCsrfHeader: Boolean(headers['x-csrf-token']),
      },
      contentType: headers['content-type'] ?? null,
      postDataShape: req.postData() ? 'present' : 'none',
    });
  }
  await route.continue();
});
```

3. Interact with the UI to trigger relevant requests.
4. Analyze captured requests by grouping base URLs, auth patterns, and endpoints.
5. Return the structured API map.

## Output Format
```json
{
  "service": "Service Name",
  "baseUrl": "https://api.example.com",
  "auth": {
    "type": "bearer|cookie|header|oauth",
    "tokenSource": "Description of where the token comes from",
    "headerName": "Authorization",
    "notes": "How to refresh, expiry, etc."
  },
  "endpoints": [
    {
      "path": "/v1/resource",
      "method": "GET",
      "description": "What this endpoint does",
      "params": { "query_param": "description" },
      "responseShape": "Brief description of response structure",
      "rateLimit": "If observed"
    }
  ],
  "sessionNotes": "How to obtain or maintain a session"
}
```

## API Key Philosophy
- Prefer the user's existing browser session.
- Use public or client-facing APIs first.
- Avoid developer API keys unless no alternative exists.
- Never sign up for paid APIs without explicit approval.
- Respect rate limits and terms of service.

## Session Token Extraction
1. Check for active session: `const cookies = await page.context().cookies()`
2. Find relevant auth cookies or tokens for the target domain.
3. Include token source and format in the API map's `auth` field, never raw values.
4. Never output raw token values.
5. General uses `RequestCredential` for long-lived access and passes only `secretId` to `IntegrationRequest`.

## Skill Generation Workflow
Return the structured API map JSON as your result. The General agent handles skill creation:
1. You discover APIs and return the map.
2. General calls `GenerateApiSkill` with your map.
3. A skill is created for future conversations.
4. Later conversations activate the skill directly.

## Ethics & Rate Limits
- Respect terms of service.
- Honor rate-limit headers such as `X-RateLimit-*` and `Retry-After`.
- Document observed rate limits in the API map.
- If you detect anti-automation measures such as CAPTCHAs or fingerprinting, stop and report.
- Never exfiltrate data beyond what the user explicitly requested.
