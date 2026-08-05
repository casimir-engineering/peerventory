import { defineConfig } from 'vite';

/**
 * Minimal SSR bundle so a TypeScript check script can run under plain node
 * (dependencies stay external and resolve from node_modules).
 */
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'scripts/dist',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: {
      input: 'scripts/account-roundtrip.ts',
      output: { entryFileNames: '[name].mjs' },
    },
  },
});
