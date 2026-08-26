import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve repository root relative to this file so Vitest behaves the same
// regardless of the current working directory when invoked from packages.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname);

export default defineConfig({
  root: repoRoot,
  test: {
    environment: 'node',
    globals: true,
    setupFiles: [path.resolve(repoRoot, 'vitest.setup.ts')],
    include: [
      // Clean and broad globs per repository requirements
      'packages/**/*.{test,spec}.{ts,tsx}',
      'apps/**/*.{test,spec}.{ts,tsx}',
      'tests/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'dashboard-backup-*/**',
      '**/*.d.ts',
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: path.resolve(repoRoot, 'coverage'),
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/bot/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/__tests__/**', '**/dist/**'],
    },
  },
});
