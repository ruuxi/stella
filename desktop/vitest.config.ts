import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    server: {
      deps: {
        inline: true,
      },
    },
    projects: [
      {
        test: {
          name: 'runtime',
          environment: 'node',
          include: [
            'tests/runtime/**/*.{test,spec}.{ts,tsx}',
            'tests/app/**/*.{test,spec}.{ts,tsx}',
          ],
        },
        resolve: {
          alias: [
            { find: /^@\//, replacement: `${path.resolve(__dirname, './src')}/` },
          ],
        },
      },
    ],
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(__dirname, './src')}/` },
    ],
  },
});
