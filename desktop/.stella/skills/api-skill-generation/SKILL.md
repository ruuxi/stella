---
id: api-skill-generation
name: API Skill Generation
description: Convert browser API discovery results into reusable skills after the Browser agent returns an API map.
agentTypes:
  - general
tags:
  - api
  - integration
  - skill-generation
version: 1
---

# API Skill Generation

When the Browser agent returns an API map from investigation, convert it into a persistent skill.

## Workflow
1. Browser agent discovers APIs via network interception and returns structured API map JSON.
2. Call `GenerateApiSkill(service, baseUrl, auth, endpoints, ...)` with the map data.
3. A skill is created with endpoint documentation and auth configuration.
4. Future conversations can `ActivateSkill(skillId)` to activate the skill.
5. Use `IntegrationRequest` to call the discovered endpoints.

## GenerateApiSkill Parameters
- `service`: service name such as `"Spotify"`
- `baseUrl`: API base URL
- `auth`: `{ type, tokenSource?, headerName?, notes? }`
- `endpoints`: `[{ path, method?, description?, params?, responseShape?, rateLimit? }]`
- `sessionNotes`: how to obtain or maintain a session
- `canvasHint`: suggested visualization type such as `"table"`, `"chart"`, `"feed"`, `"player"`, or `"dashboard"`
- `tags`: optional tags for discovery

## Session Auth Handling
When the Browser agent detects auth material in an active session:
- Never include raw token or cookie values in task outputs, generated skills, or other persisted artifacts.
- Return only auth metadata such as scheme, header or cookie names, and token source notes.
- The General agent should use `RequestCredential` to collect user-provided credentials and pass only `secretId` to `IntegrationRequest`.

## Canvas Display
Include `canvasHint` to suggest how to display results. The generated skill should include instructions for writing a panel TSX file and reporting the panel name to the user.
