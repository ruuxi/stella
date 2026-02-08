/**
 * Builtin skills — reference documentation that agents activate on demand.
 * Keeps system prompts lean; agents call ActivateSkill(id) when needed.
 */

type BuiltinSkill = {
  id: string;
  name: string;
  description: string;
  markdown: string;
  agentTypes: string[];
  tags: string[];
  source: "builtin";
  enabled: true;
};

// ---------------------------------------------------------------------------
// General Agent Skills
// ---------------------------------------------------------------------------

const WORKSPACE: BuiltinSkill = {
  id: "workspace",
  name: "Workspace Panels & Apps",
  description:
    "Create interactive canvas content. Panels: single-file TSX compiled by Vite. Apps: full Vite+React projects with own deps and dev servers.",
  agentTypes: ["general"],
  tags: ["canvas", "react", "workspace", "vite"],
  source: "builtin",
  enabled: true,
  markdown: `# Workspace Panels & Apps

Two ways to show interactive content in the canvas panel.

## Panels (single-file TSX)

For visualizations, interactive controls, data display, and anything you want to show visually.
Vite compiles the file on demand — can import any installed frontend dep (react, radix, recharts, tailwind, @/hooks/*).

### Workflow
1. Write the component:
   \`Write(file_path="frontend/workspace/panels/my-chart.tsx", content="...")\`
2. Open canvas:
   \`OpenCanvas(name="my-chart")\`

### Source Format
Must export a default React component.

\`\`\`tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

const data = [
  { name: "Jan", value: 400 },
  { name: "Feb", value: 300 },
];

export default function Chart() {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Bar dataKey="value" fill="#8884d8" />
      </BarChart>
    </ResponsiveContainer>
  );
}
\`\`\`

### Updating a Panel
Write to the same file again, then call OpenCanvas again — Vite recompiles on the fresh import.

## Apps (full Vite+React projects)

For multi-file apps that need their own npm dependencies, persistent state, or complex project structure.

### Workflow
1. Scaffold: \`Bash(command="node frontend/workspace/create-app.js my-app")\`
2. Add deps: \`Bash(command="cd ~/.stella/apps/my-app && bun add three @react-three/fiber")\`
3. Edit files: Use Write/Edit on \`~/.stella/apps/my-app/src/App.tsx\` etc.
4. Start dev server: \`Bash(command="cd ~/.stella/apps/my-app && bunx vite --port 5180", run_in_background=true)\`
5. Show in canvas: \`OpenCanvas(name="my-app", url="http://localhost:5180")\`
6. Stop server when done: Use \`Bash(kill_shell_id="<id>")\` with the shell ID from step 4.

### When to Use Panels vs Apps
- **Panel**: Self-contained single file, quick prototypes, data visualization
- **App**: Multi-file projects, npm dependencies (three.js, tone.js, etc.), persistent projects

### Closing
\`CloseCanvas()\` — closes the canvas panel.`,
};

const STORE_MANAGEMENT: BuiltinSkill = {
  id: "store-management",
  name: "Store Search & Package Installation",
  description:
    "Search the app store and install packages (skills, themes, mini-apps, plugins). Mod installs must be delegated to Self-Mod.",
  agentTypes: ["general"],
  tags: ["store", "packages", "install"],
  source: "builtin",
  enabled: true,
  markdown: `# Store Search & Package Installation

## Searching
\`StoreSearch(query, type?)\` — types: skill, mod, theme, canvas, plugin.

Search proactively when the user asks for something that might exist as a package. Suggest packages conversationally — don't force installation.

## Installing

**Mod installs**: Always delegate to Self-Mod agent via Task. Mods are blueprints that need re-implementation — General cannot install them.

**Skill installs**:
\`InstallSkillPackage({ packageId, skillId, name, markdown, agentTypes?, tags? })\`

**Theme installs**:
\`InstallThemePackage({ packageId, themeId, name, light, dark })\`

**Mini-app installs**:
\`InstallCanvasPackage({ packageId, name, dependencies?, source? })\`

**Plugin installs**:
\`InstallPluginPackage({ packageId, pluginId?, manifest?, files? })\`

## Uninstalling
\`UninstallPackage({ packageId, type, localId })\`
- type: "skill" | "theme" | "canvas" | "plugin" | "mod"
- localId: the local identifier (skillId, themeId, workspaceId, etc.)`,
};

const API_SKILL_GENERATION: BuiltinSkill = {
  id: "api-skill-generation",
  name: "API Skill Generation",
  description:
    "Convert browser API discovery results into reusable skills. Use after Browser agent returns an API map.",
  agentTypes: ["general"],
  tags: ["api", "integration", "skill-generation"],
  source: "builtin",
  enabled: true,
  markdown: `# API Skill Generation

When the Browser agent returns an API map from investigation, convert it into a persistent skill.

## Workflow
1. Browser agent discovers APIs via network interception → returns structured API map JSON
2. Call \`GenerateApiSkill(service, baseUrl, auth, endpoints, ...)\` with the map data
3. A skill is created with endpoint documentation and auth configuration
4. Future conversations can \`ActivateSkill(skillId)\` to load the API docs
5. Use \`IntegrationRequest\` to call the discovered endpoints

## GenerateApiSkill Parameters
- \`service\`: Service name (e.g., "Spotify")
- \`baseUrl\`: API base URL
- \`auth\`: { type, tokenSource?, headerName?, notes? }
- \`endpoints\`: [{ path, method?, description?, params?, responseShape?, rateLimit? }]
- \`sessionNotes\`: How to obtain/maintain a session
- \`canvasHint\`: Suggested display — "table", "chart", "feed", "player", "dashboard"
- \`tags\`: Optional tags for discovery

## Session Token Forwarding
When the Browser agent extracts auth tokens from an active session:
- Pass them to \`IntegrationRequest\` via the \`request.headers\` field for immediate use
- Tokens are ephemeral — not stored in the backend secrets table
- For persistent access, use \`RequestCredential\` to ask the user to store tokens properly

## Canvas Display
Include \`canvasHint\` to suggest how to display results. The generated skill will include Canvas usage instructions matching the hint.`,
};

// ---------------------------------------------------------------------------
// Self-Mod Agent Skills
// ---------------------------------------------------------------------------

const FRONTEND_ARCHITECTURE: BuiltinSkill = {
  id: "frontend-architecture",
  name: "Frontend Architecture Reference",
  description:
    "Full design system reference: directory structure, layout, CSS tokens, plugin slots, canvas system. Activate before structural changes.",
  agentTypes: ["self_mod"],
  tags: ["architecture", "design-system", "reference"],
  source: "builtin",
  enabled: true,
  markdown: `# Frontend Architecture Reference

## Technology Stack
- **React 19** + **TypeScript** in Electron (Vite bundler with HMR)
- **Tailwind CSS v4** (classes directly, no config file)
- **CSS custom properties** on \`:root\` for theming (OKLCH color system)
- **Radix UI** primitives for accessible components
- **CVA** (class-variance-authority) for component variants
- Path alias: \`@/*\` maps to \`src/*\`

## Source Layout
\`\`\`
frontend/src/
├── main.tsx                    # Entry point, provider nesting, CSS imports
├── App.tsx                     # Window router (full/mini/radial/region)
├── app/state/
│   ├── ui-state.tsx            # UiStateProvider (mode, window, conversationId)
│   └── canvas-state.tsx        # CanvasProvider (isOpen, canvas, width)
├── components/
│   ├── canvas/
│   │   ├── CanvasPanel.tsx     # Canvas panel (url → iframe, else → panel)
│   │   ├── CanvasErrorBoundary.tsx # Error boundary for renderers
│   │   └── renderers/          # panel.tsx (Vite dynamic), appframe.tsx (iframe)
│   ├── chat/                   # Message rendering (Markdown, MessageGroup, etc.)
│   ├── Sidebar.tsx             # Left navigation
│   ├── button.tsx / .css       # Button component (pattern for all primitives)
│   └── ...                     # 30+ component files (each with paired .css)
├── screens/
│   ├── FullShell.tsx           # Re-export from full-shell/
│   ├── full-shell/
│   │   ├── FullShell.tsx       # Layout shell (sidebar + chat + canvas)
│   │   ├── ChatColumn.tsx      # Chat area (messages + composer)
│   │   ├── Composer.tsx        # Input bar, attachments, submit
│   │   ├── OnboardingOverlay.tsx # Onboarding state + view
│   │   ├── DiscoveryFlow.tsx   # Discovery categories + signals
│   │   ├── use-streaming-chat.ts # Streaming state machine hook
│   │   └── use-full-shell.ts   # Scroll management hook
│   ├── MiniShell.tsx           # Spotlight overlay
│   ├── RadialDial.tsx          # Radial menu
│   └── RegionCapture.tsx       # Screenshot region selector
├── plugins/
│   ├── registry.ts             # Slot registry (registerSlot, overrideSlot, useSlot)
│   ├── types.ts                # UIPlugin, SlotDefinition types
│   └── slots.ts                # Default slot registrations
├── styles/
│   ├── canvas-panel.css        # Canvas panel layout
│   ├── full-shell.layout.css   # Main layout (.full-body flex row)
│   ├── full-shell.composer.css # Message composer
│   └── ...                     # Modular CSS files (each imported in main.tsx)
└── theme/
    ├── theme-context.tsx       # ThemeProvider (15 themes, OKLCH, light/dark)
    ├── themes.ts               # Theme definitions
    └── color.ts                # OKLCH color math
\`\`\`

## Key Layout Structure
\`\`\`
.full-body (flex-direction: row)
├── Sidebar (left nav, ~240px)
├── .full-body-main (flex: 1, column)
│   ├── .session-content (scrollable messages)
│   │   └── .session-messages (max-width: 50rem, centered)
│   └── Composer (absolute bottom, input bar)
└── CanvasPanel (right side, resizable, conditional)
\`\`\`

## CSS Design Tokens
\`\`\`css
/* Text hierarchy */
--text-strong, --text-base, --text-weak, --text-weaker

/* Surfaces (semi-transparent for gradient show-through) */
--surface-inset, --surface-raised, --surface-raised-hover, --surface-overlay

/* Borders */
--border-base, --border-weak, --border-strong

/* Interactive */
--interactive, --interactive-hover

/* Sizing */
--radius-sm, --radius-md, --radius-lg, --radius-full
--font-family-mono  (IBM Plex Mono)
\`\`\`

## Plugin Slot System
Components are registered in named slots that can be overridden:
\`\`\`typescript
import { useSlot, overrideSlot } from '@/plugins'

// In FullShell — renders whatever is registered for 'sidebar'
const SidebarSlot = useSlot('sidebar')

// Override a slot (from a plugin or self-mod):
overrideSlot('sidebar', MyCustomSidebar, { priority: 10, source: 'self-mod' })
\`\`\`

## Canvas System
Side panel for rendering interactive content alongside chat:
- **Panels**: Single-file TSX in \`workspace/panels/\` — Vite-compiled on demand via dynamic import
- **Apps**: Full Vite+React projects in \`~/.stella/apps/\` — rendered via sandboxed iframe

\`CanvasPanel.tsx\` routes by URL: if \`canvas.url\` is set → iframe (AppframeRenderer), otherwise → Vite dynamic import (PanelRenderer).`,
};

const BLUEPRINT_MANAGEMENT: BuiltinSkill = {
  id: "blueprint-management",
  name: "Blueprint Management",
  description:
    "Create shareable blueprints from features, or install blueprints from the store. Activate before blueprint operations.",
  agentTypes: ["self_mod"],
  tags: ["blueprint", "self-mod", "sharing"],
  source: "builtin",
  enabled: true,
  markdown: `# Blueprint Management

## Creating Blueprints (sharing your work)

When the user wants to share a feature:
1. Call \`SelfModPackage\` with:
   - **description**: Clear, user-facing summary of what the feature does
   - **implementation**: Detailed, developer-facing explanation of HOW you implemented it — which files you changed, what patterns you used, architectural decisions you made, and why. This is what another AI reads to re-implement the feature.
2. The blueprint contains your reference code plus description and implementation notes
3. Publish to the store if the user wants to share publicly

## Installing Blueprints (implementing someone else's feature)

1. Call \`SelfModInstallBlueprint(package_id)\` to fetch the blueprint
2. Read the description, implementation notes, and reference files carefully
3. Understand the **INTENT** — what the feature does and why the original author made specific choices
4. Examine the current codebase before implementing:
   - Has the target component/file changed since the blueprint was created?
   - Are there better patterns available now?
   - Will the changes interact with the current theme?
5. Choose your approach based on what the feature needs:
   - **CSS variable overrides**: For pure style changes (colors, spacing, fonts)
   - **Component edits**: For structural changes to existing components
   - **New files**: For entirely new features or components
6. Re-implement the feature fresh, adapting to the current codebase:
   - Use SelfModStart to create a new feature
   - Use Write/Edit to implement (goes through staging)
   - Use SelfModApply when done
7. You are NOT copying files — you are understanding the blueprint and making engineering decisions about how to achieve the same result in the current codebase
8. After applying, summarize what you did differently from the blueprint and why

## Safety
- Always Read files before modifying — understand existing patterns
- Before risky multi-file edits, run \`Bash("git stash push -u -m 'self-mod-prep'")\` if the working tree is dirty
- Use error boundaries for complex new components
- Prefer SelfModRevert over manual fixups when something goes wrong
- Split large batches (5+ files) into smaller applies for safer rollback`,
};

// ---------------------------------------------------------------------------
// Browser Agent Skills
// ---------------------------------------------------------------------------

const BROWSER_API_DISCOVERY: BuiltinSkill = {
  id: "browser-api-discovery",
  name: "API Discovery Mode",
  description:
    "Network interception, API reverse engineering, session token extraction, and structured output format for API mapping.",
  agentTypes: ["browser"],
  tags: ["api", "network", "discovery"],
  source: "builtin",
  enabled: true,
  markdown: `# API Discovery Mode

When asked to investigate or reverse-engineer a web service's API.

## Process
1. **Navigate** to the service's web app (use the user's existing browser session if possible)
2. **Enable network interception** to capture all API calls:
   \`\`\`javascript
   state.apiCalls = [];
   await page.route('**/*', async route => {
     const req = route.request();
     if (req.resourceType() === 'fetch' || req.resourceType() === 'xhr') {
       state.apiCalls.push({
         url: req.url(),
         method: req.method(),
         headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) =>
           ['authorization', 'content-type', 'x-csrf-token', 'cookie'].includes(k.toLowerCase())
         )),
         postData: req.postData(),
       });
     }
     await route.continue();
   });
   \`\`\`
3. **Interact** with the UI to trigger API calls (browse, search, play, etc.)
4. **Analyze** captured requests: group by base URL, identify auth patterns, map endpoints
5. **Document** findings as the structured API map below

## Output Format (return this as your result)
\`\`\`json
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
  "sessionNotes": "How to obtain/maintain a session"
}
\`\`\`

## API Key Philosophy
- **Prefer user's existing browser session** — extract cookies/tokens from the active session
- **Use public/client-facing APIs first** — designed for browser use, no developer key needed
- **Avoid developer API keys** unless no alternative exists
- **Never sign up for paid APIs** without explicit user approval
- **Respect rate limits and ToS** — you're a guest on their platform
- If requires a developer account and no browser session works, report back and ask the user

## Session Token Extraction
1. Check for active session: \`const cookies = await page.context().cookies()\`
2. Find relevant auth cookies/tokens for the target domain
3. Include token source and format in the API map's \`auth\` field
4. The General agent passes tokens to \`IntegrationRequest\` via \`request.headers\` (ephemeral)
5. Tokens expire when the browser session ends — for long-lived access, General uses RequestCredential

## Skill Generation Workflow
Return the structured API map JSON as your result. The General agent handles skill creation:
1. You discover APIs → return the map
2. General calls \`GenerateApiSkill\` with your map
3. A skill is created for future conversations
4. Next time → agents activate the skill directly, no re-discovery needed

## Ethics & Rate Limits
- Respect ToS — don't scrape beyond what a normal user would do
- Honor rate limits in response headers (\`X-RateLimit-*\`, \`Retry-After\`)
- Document observed rate limits in the API map
- If you detect anti-automation measures (CAPTCHAs, fingerprinting), stop and report
- Never exfiltrate data beyond what the user explicitly requested`,
};

const BROWSER_ADVANCED_TOOLS: BuiltinSkill = {
  id: "browser-advanced-tools",
  name: "Browser Advanced Tools",
  description:
    "Utility functions: getCleanHTML, createDebugger, createEditor, getLatestLogs, getReactSource, getStylesForLocator, response body reading.",
  agentTypes: ["browser"],
  tags: ["browser", "debugging", "utilities"],
  source: "builtin",
  enabled: true,
  markdown: `# Browser Advanced Tools

## getLatestLogs
Retrieve captured browser console logs (up to 5000 per page, cleared on navigation):
\`\`\`js
await getLatestLogs({ page?, count?, search? })
const errors = await getLatestLogs({ search: /error/i, count: 50 })
\`\`\`
For custom collection: \`state.logs = []; page.on('console', m => state.logs.push(m.text()))\`

## getCleanHTML
Get cleaned HTML from a locator or page:
\`\`\`js
await getCleanHTML({ locator, search?, showDiffSinceLastCall?, includeStyles? })
const html = await getCleanHTML({ locator: page.locator('body') })
const diff = await getCleanHTML({ locator: page, showDiffSinceLastCall: true })
\`\`\`

## waitForPageLoad
Smart load detection that ignores analytics/ads:
\`\`\`js
await waitForPageLoad({ page, timeout?, pollInterval?, minWait? })
// Returns: { success, readyState, pendingRequests, waitTimeMs, timedOut }
\`\`\`

## getCDPSession
Send raw Chrome DevTools Protocol commands:
\`\`\`js
const cdp = await getCDPSession({ page });
const metrics = await cdp.send('Page.getLayoutMetrics');
\`\`\`

## getLocatorStringForElement
Get stable selector from ephemeral aria-ref:
\`\`\`js
const selector = await getLocatorStringForElement(page.locator('aria-ref=e14'));
// => "getByRole('button', { name: 'Save' })"
\`\`\`

## getReactSource
Get React component source location (dev mode only):
\`\`\`js
const source = await getReactSource({ locator: page.locator('aria-ref=e5') });
// => { fileName, lineNumber, columnNumber, componentName }
\`\`\`

## getStylesForLocator
Inspect CSS styles applied to an element:
\`\`\`js
const styles = await getStylesForLocator({ locator: page.locator('.btn'), cdp: await getCDPSession({ page }) });
console.log(formatStylesAsText(styles));
\`\`\`

## createDebugger
Set breakpoints, step through code, inspect variables:
\`\`\`js
const cdp = await getCDPSession({ page }); const dbg = createDebugger({ cdp }); await dbg.enable();
const scripts = await dbg.listScripts({ search: 'app' });
await dbg.setBreakpoint({ file: scripts[0].url, line: 42 });
// when paused: dbg.inspectLocalVariables(), dbg.stepOver(), dbg.resume()
\`\`\`

## createEditor
View and live-edit page scripts and CSS at runtime:
\`\`\`js
const cdp = await getCDPSession({ page }); const editor = createEditor({ cdp }); await editor.enable();
const matches = await editor.grep({ regex: /console\\.log/ });
await editor.edit({ url: matches[0].url, oldString: 'DEBUG = false', newString: 'DEBUG = true' });
\`\`\`

## Reading Response Bodies
By default, hera-browser disables CDP response body buffering for SSE. Re-enable if needed:
\`\`\`js
const cdp = await getCDPSession({ page });
await cdp.send('Network.disable');
await cdp.send('Network.enable', {
  maxTotalBufferSize: 10000000,
  maxResourceBufferSize: 5000000
});

const [response] = await Promise.all([
  page.waitForResponse(resp => resp.url().includes('/api/data')),
  page.click('button.load-data')
]);
const body = await response.text();
\`\`\`

## Debugging hera-browser Issues
Read relay server logs:
\`\`\`bash
hera-browser logfile
# typically: /tmp/hera-browser/relay-server.log or %TEMP%\\hera-browser\\relay-server.log
\`\`\``,
};

const BROWSER_PATTERNS: BuiltinSkill = {
  id: "browser-patterns",
  name: "Browser Common Patterns",
  description:
    "Common Playwright patterns: popups, downloads, iframes, dialogs, file loading, network interception.",
  agentTypes: ["browser"],
  tags: ["browser", "patterns", "playwright"],
  source: "builtin",
  enabled: true,
  markdown: `# Browser Common Patterns

## Popups
Capture before triggering:
\`\`\`js
const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('a[target=_blank]')]);
await popup.waitForLoadState();
console.log('Popup URL:', popup.url());
\`\`\`

## Downloads
Capture and save:
\`\`\`js
const [download] = await Promise.all([page.waitForEvent('download'), page.click('button.download')]);
await download.saveAs(\`/tmp/\${download.suggestedFilename()}\`);
\`\`\`

## iFrames
Use frameLocator:
\`\`\`js
const frame = page.frameLocator('#my-iframe');
await frame.locator('button').click();
\`\`\`

## Dialogs
Handle alerts/confirms/prompts:
\`\`\`js
page.on('dialog', async dialog => {
  console.log(dialog.message());
  await dialog.accept();
});
await page.click('button.trigger-alert');
\`\`\`

## Loading Files
Fill inputs with file content:
\`\`\`js
const fs = require('node:fs');
const content = fs.readFileSync('./data.txt', 'utf-8');
await page.locator('textarea').fill(content);
\`\`\`

## Network Interception
Intercept requests instead of scrolling DOM:
\`\`\`js
state.requests = []; state.responses = [];
page.on('request', req => {
  if (req.url().includes('/api/'))
    state.requests.push({ url: req.url(), method: req.method(), headers: req.headers() });
});
page.on('response', async res => {
  if (res.url().includes('/api/')) {
    try { state.responses.push({ url: res.url(), status: res.status(), body: await res.json() }); } catch {}
  }
});
\`\`\`

Analyze captured data:
\`\`\`js
console.log('Captured', state.responses.length, 'API calls');
state.responses.forEach(r => console.log(r.status, r.url.slice(0, 80)));
\`\`\`

Replay API directly (useful for pagination):
\`\`\`js
const { url, headers } = state.requests.find(r => r.url.includes('feed'));
const data = await page.evaluate(async ({ url, headers }) => {
  const res = await fetch(url, { headers });
  return res.json();
}, { url, headers });
\`\`\`

Clean up: \`page.removeAllListeners('request'); page.removeAllListeners('response');\``,
};

// ---------------------------------------------------------------------------
// Export all builtin skills
// ---------------------------------------------------------------------------

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  // General agent
  WORKSPACE,
  STORE_MANAGEMENT,
  API_SKILL_GENERATION,
  // Self-mod agent
  FRONTEND_ARCHITECTURE,
  BLUEPRINT_MANAGEMENT,
  // Browser agent
  BROWSER_API_DISCOVERY,
  BROWSER_ADVANCED_TOOLS,
  BROWSER_PATTERNS,
];
