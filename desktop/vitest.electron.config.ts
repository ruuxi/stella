import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['electron/**/*.test.ts', 'packages/**/*.test.ts'],
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
      { find: /^@stella\/stella-ai$/, replacement: path.resolve(__dirname, './packages/stella-ai/src/index.ts') },
      { find: /^@stella\/stella-agent-core$/, replacement: path.resolve(__dirname, './packages/stella-agent-core/src/index.ts') },
      { find: /^@stella\/stella-runtime$/, replacement: path.resolve(__dirname, './packages/stella-runtime/src/index.ts') },
      {
        find: /^@stella\/stella-runtime\/(.*)$/,
        replacement: `${path.resolve(__dirname, './packages/stella-runtime/src')}/$1`,
      },
    ],
  },
});
