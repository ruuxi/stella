/**
 * Template strings for scaffolding workspace Vite+React projects.
 */
export const packageJsonTemplate = (name, dependencies) => JSON.stringify({
    name,
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: {
        dev: 'vite',
        build: 'vite build',
    },
    dependencies: {
        react: '^19.2.0',
        'react-dom': '^19.2.0',
        ...(dependencies ?? {}),
    },
    devDependencies: {
        '@types/react': '^19.2.5',
        '@types/react-dom': '^19.2.3',
        '@vitejs/plugin-react': '^5.1.1',
        typescript: '~5.9.3',
        vite: '^7.2.4',
    },
}, null, 2);
export const viteConfigTemplate = () => `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    strictPort: false,
  },
})
`;
export const indexHtmlTemplate = (name) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
export const mainTsxTemplate = () => `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`;
export const appTsxTemplate = (name) => `export default function App() {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>${name}</h1>
      <p>Edit <code>src/App.tsx</code> to get started.</p>
    </div>
  )
}
`;
export const tsconfigTemplate = () => JSON.stringify({
    compilerOptions: {
        target: 'ES2020',
        useDefineForClassFields: true,
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        skipLibCheck: true,
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        isolatedModules: true,
        moduleDetection: 'force',
        noEmit: true,
        jsx: 'react-jsx',
        strict: true,
        noUnusedLocals: false,
        noUnusedParameters: false,
    },
    include: ['src'],
}, null, 2);
