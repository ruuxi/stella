# Google Workspace MCP (bundled)

This directory holds the built **Google Workspace MCP server** from
[gemini-cli-extensions/workspace](https://github.com/gemini-cli-extensions/workspace).

## Populate / update

From the `desktop/` folder:

```bash
npm run vendor:google-workspace-mcp
```

This clones a pinned tag, runs `npm install` and `npm run build -w workspace-server`, and copies `workspace-server/dist/` here.

## Override path

Set `STELLA_GOOGLE_WORKSPACE_MCP_PATH` to an absolute path to `index.js` if you use a custom build.

In packaged Stella builds, the Electron main process sets `STELLA_APP_RESOURCES_PATH` so the MCP loader can find this folder under `process.resourcesPath` (see `extraResources` in `package.json`).

## OAuth

Authentication uses the upstream server’s OAuth flow (browser sign-in, local token storage). See the upstream repository documentation.
