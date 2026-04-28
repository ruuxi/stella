import path from "path";
import { promises as fs } from "fs";

const SENTINEL_FILE = ".stella-social-template.json";
const TEMPLATE_VERSION = 1;

type TemplateFile = {
  relativePath: string;
  contents: string;
};

const PACKAGE_JSON = `{
  "name": "stella-social-workspace",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@types/react": "^19.2.5",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.1",
    "typescript": "~5.9.3",
    "vite": "^7.2.4"
  }
}
`;

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: false,
  },
})
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false
  },
  "include": ["src"]
}
`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Stella Social Workspace</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const MAIN_TSX = `import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)
`;

const APP_TSX = `export default function App() {
  return (
    <main className="stage">
      <section className="card">
        <p className="eyebrow">Stella Together</p>
        <h1>Your shared workspace is ready.</h1>
        <p className="body">
          Ask Stella to build something here and the result will appear in
          this preview live for everyone in the chat.
        </p>
      </section>
    </main>
  )
}
`;

const STYLES_CSS = `:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    'Segoe UI', sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

body {
  margin: 0;
  min-height: 100vh;
  background: radial-gradient(
      circle at 20% 20%,
      rgba(125, 165, 255, 0.18),
      transparent 55%
    ),
    radial-gradient(
      circle at 80% 80%,
      rgba(255, 192, 222, 0.18),
      transparent 55%
    ),
    #0c0d12;
  color: #f3f5fb;
}

.stage {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 32px;
  box-sizing: border-box;
}

.card {
  width: 100%;
  max-width: 520px;
  padding: 40px;
  border-radius: 18px;
  background: rgba(20, 22, 30, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
}

.eyebrow {
  margin: 0 0 12px;
  font-size: 12px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: rgba(243, 245, 251, 0.55);
}

h1 {
  margin: 0 0 16px;
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.body {
  margin: 0;
  font-size: 15px;
  line-height: 1.6;
  color: rgba(243, 245, 251, 0.78);
}
`;

const README = `# Stella Social Workspace

This folder is a shared, live-preview Vite + React workspace for a Stella
Together session. The Stella desktop app runs the dev server automatically
and shows it in the Social tab of the workspace panel.

You should not need to run any commands manually. Edit \`src/App.tsx\` (or
ask Stella to edit it for you) and the preview updates in real time.
`;

const TEMPLATE_FILES: ReadonlyArray<TemplateFile> = [
  { relativePath: "package.json", contents: PACKAGE_JSON },
  { relativePath: "vite.config.ts", contents: VITE_CONFIG },
  { relativePath: "tsconfig.json", contents: TSCONFIG },
  { relativePath: "index.html", contents: INDEX_HTML },
  { relativePath: "src/main.tsx", contents: MAIN_TSX },
  { relativePath: "src/App.tsx", contents: APP_TSX },
  { relativePath: "src/styles.css", contents: STYLES_CSS },
  { relativePath: "README.md", contents: README },
];

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Idempotently materializes the social workspace template at `rootPath`.
 *
 * Behavior:
 * - If the sentinel file exists with the current `TEMPLATE_VERSION`, do
 *   nothing.
 * - Otherwise, write any template files that are missing. Files that
 *   already exist are left as-is so that user / agent edits are never
 *   clobbered.
 * - Always (re)write the sentinel file at the end.
 *
 * Returns `true` when one or more template files were created.
 */
export const ensureSocialWorkspaceTemplate = async (
  rootPath: string,
): Promise<boolean> => {
  const sentinelPath = path.join(rootPath, SENTINEL_FILE);
  if (await fileExists(sentinelPath)) {
    try {
      const raw = await fs.readFile(sentinelPath, "utf8");
      const parsed = JSON.parse(raw) as { version?: number };
      if (parsed?.version === TEMPLATE_VERSION) {
        return false;
      }
    } catch {
      // Fall through and re-materialize defensively.
    }
  }

  await fs.mkdir(rootPath, { recursive: true });

  let createdAny = false;
  for (const file of TEMPLATE_FILES) {
    const absolutePath = path.join(rootPath, file.relativePath);
    if (await fileExists(absolutePath)) {
      continue;
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, file.contents, "utf8");
    createdAny = true;
  }

  await fs.writeFile(
    sentinelPath,
    JSON.stringify(
      {
        version: TEMPLATE_VERSION,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  return createdAny;
};
