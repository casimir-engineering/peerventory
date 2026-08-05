import { defineConfig } from 'vite';

/**
 * Minimal SSR bundle so a TypeScript check script can run under plain node
 * (dependencies stay external and resolve from node_modules).
 */
export default defineConfig({
  // exceljs is CommonJS and the app imports it by name, which plain node ESM
  // cannot do against an external CJS module: bundle it in instead.
  ssr: { noExternal: ['exceljs'] },
  build: {
    ssr: true,
    outDir: 'scripts/dist',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: {
      input: ['scripts/account-roundtrip.ts', 'scripts/stats-quantity.ts'],
      output: { entryFileNames: '[name].mjs' },
    },
  },
});
