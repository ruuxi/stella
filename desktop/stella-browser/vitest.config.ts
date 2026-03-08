import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: path.resolve(__dirname, '..'),
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/stella-browser/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'dist-electron'],
  },
})
