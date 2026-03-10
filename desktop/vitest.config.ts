import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/support/renderer/setup.ts'],
    include: ['tests/renderer/**/*.{test,spec}.{ts,tsx}'],
    server: {
      deps: {
        inline: true,
      },
    },
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(__dirname, './src')}/` },
      {
        find: /^@testing-library\/react$/,
        replacement: path.resolve(__dirname, './tests/support/renderer/react-testing.tsx'),
      },
      { find: /^react$/, replacement: path.resolve(__dirname, './node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: path.resolve(__dirname, './node_modules/react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.resolve(__dirname, './node_modules/react/jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: path.resolve(__dirname, './node_modules/react-dom/index.js') },
      { find: /^react-dom\/client$/, replacement: path.resolve(__dirname, './node_modules/react-dom/client.js') },
    ],
    dedupe: ['react', 'react-dom'],
  },
});
