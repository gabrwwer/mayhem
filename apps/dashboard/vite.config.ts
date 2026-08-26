/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Deterministic asset names so public/index.html (static entry) can
// reference the built bundle without hashed filenames.
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, '../../', '');

  return {
    plugins: [react()],
    base: '/',
    envDir: '../../',
    define: {
      'import.meta.env.VITE_API_TOKEN': JSON.stringify(
        rootEnv.VITE_API_TOKEN ?? rootEnv.API_AUTH_TOKEN ?? '',
      ),
    },
    server: {
    // Matches DASHBOARD_PORT / CORS_ORIGINS in the project's .env files.
    // strictPort ensures a startup failure (loud, in the terminal) instead
    // of silently falling back to another port — a stale/wrong port here
    // previously caused "no live data" confusion because the dashboard
    // was being viewed on Vite's default port (5173) while every .env
    // file assumed port 5487.
      port: 5487,
      strictPort: true,
    },
    build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});