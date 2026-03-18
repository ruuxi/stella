import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/electron/**/*.test.ts', 'tests/packages/**/*.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      'dist-electron',
    ],
    testTimeout: 30000,
  },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(__dirname, './src')}/` },
    ],
  },
});
