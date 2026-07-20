    import { defineConfig } from 'vite';
    import react from '@vitejs/plugin-react';
    import { crx } from '@crxjs/vite-plugin';
    import manifest from './src/manifest';

    export default defineConfig({
      plugins: [
        react(),
        crx({
          manifest,
          contentScripts: {
            // Register extractor.ts as a standalone IIFE content script so crxjs
            // bundles it (with all its npm dependencies inlined) at the predictable
            // path: dist/src/content-scripts/extractor.js
            // That path exactly matches the files[] entry in background/index.ts.
            standaloneFiles: ['src/content-scripts/extractor.ts'],
          },
        }),
      ],
      build: {
        target: 'esnext',
      },
    });
