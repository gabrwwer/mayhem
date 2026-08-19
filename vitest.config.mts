import { defineConfig } from 'vitest/config';

/**
 * No module aliases.
 *
 * A temporary alias block mirrored a tsconfig `paths` bridge while the
 * @mayhem/* sources lived inside node_modules. Both are gone: packages/*
 * is restored and pnpm links the workspace, so Vitest resolves the same way
 * Node does. Keeping aliases around after that point is a liability — they
 * silently win over the real link, so the tests can pass against code the
 * application never loads.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // This file previously pointed at a setup file that did not exist,
    // which made Vitest fail before collecting a single test.
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'tests/**/*.test.ts',
      // Picks up the in-package suites (lock ladder, risk engine verdicts,
      // core-types schemas) now that the packages are back in the workspace.
      // While they lived under node_modules they were excluded, so they had
      // never run.
      'packages/**/src/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'dashboard-backup-*/**',
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/bot/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/__tests__/**', '**/dist/**'],
    },
  },
});
