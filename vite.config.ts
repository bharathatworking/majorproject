    import { defaultClientConditions, defineConfig } from 'vite';
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
      resolve: {
        // onnxruntime-web's export condition for an external wasm: its runtime
        // then loads the wasm (and its factory .mjs) only from wasmPaths, i.e.
        // dist/ort/ from npm run fetch-models, instead of Vite emitting a
        // second 27 MB copy as a hashed asset.
        conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
      },
      // The NLI worker (src/lib/quality/nli.worker.ts) is an ES module worker:
      // Transformers.js uses dynamic imports, which the default 'iife' format
      // can't code-split.
      worker: {
        format: 'es',
      },
    });
