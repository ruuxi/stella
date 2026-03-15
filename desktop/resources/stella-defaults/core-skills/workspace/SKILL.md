---
id: workspace
name: Workspace Panels & Apps
description: Create interactive canvas content. Panels are single-file TSX files compiled by Vite. Apps are full Vite+React projects with their own dependencies and dev servers.
agentTypes:
  - general
tags:
  - canvas
  - react
  - workspace
  - vite
version: 1
---

# Workspace Panels & Apps

Two ways to create interactive content for Stella's workspace surfaces.

## Panels (single-file TSX)

For visualizations, interactive controls, data display, and anything you want to show visually.
Vite compiles the file on demand and can import any installed desktop dependency such as `react`, `radix`, `recharts`, `tailwind`, and `@/hooks/*`.

## Workflow
1. Write the component:
   `Write(file_path="desktop/workspace/panels/my-chart.tsx", content="...")`
2. Report the panel name so the user can find it in the workspace and home pages.

## Source Format
Must export a default React component.

```tsx
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
```

## Updating a Panel
Write to the same file again, then report the panel name again. Vite recompiles the next time the user opens it from the workspace and home pages.

## Apps (full Vite+React projects)

For multi-file apps that need their own npm dependencies, persistent state, or complex project structure.

If the app is a Stella multiplayer game or needs the shared realtime game runtime, activate the `multiplayer-game` skill before scaffolding or editing it. Do not activate it for single-player apps.

## Workflow
1. Scaffold: `Bash(command="cd desktop && node scripts/create-workspace-app.mjs my-app")`
2. Add deps: `Bash(command="cd desktop/workspace/apps/my-app && bun add three @react-three/fiber")`
3. Edit files: use `Write` or `Edit` on `desktop/workspace/apps/my-app/src/App.tsx` and related files.
4. Start dev server: `Bash(command="cd desktop/workspace/apps/my-app && bunx vite --port 5180", run_in_background=true)`
5. Report the local URL, for example `http://localhost:5180`, and any usage notes to the user.
6. Stop server when done: use `KillShell(shell_id="<id>")` with the shell ID from step 4.

## When to Use Panels vs Apps
- Panel: self-contained single file, quick prototypes, data visualization
- App: multi-file projects, npm dependencies such as `three.js` or `tone.js`, persistent projects

## Access
Panels become available in the workspace and home pages after they are written. They are not auto-opened. Standalone apps should be reported with their local URL and run instructions.
