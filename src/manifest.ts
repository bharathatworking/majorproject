import { defineManifest } from '@crxjs/vite-plugin';

/** COOP + COEP: cross-origin isolation of the extension's pages (see below). */
const CROSS_ORIGIN_ISOLATION: Pick<chrome.runtime.ManifestV3, 'cross_origin_embedder_policy' | 'cross_origin_opener_policy'> = {
  cross_origin_embedder_policy: { value: 'require-corp' },
  cross_origin_opener_policy: { value: 'same-origin' },
};

export default defineManifest({
  manifest_version: 3,
  name: 'Clarity',
  version: '1.0.0',
  description: 'Read anything, at any level.',
  // Permanent RSA public key — gives this extension a fixed, deterministic ID.
  // Do NOT regenerate this key unless you intentionally want a new extension ID.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlu5WFeMkgHy8mkFaMvEOZ0rddA58MTeWntMzlHaiE5kNRCQG54lcp1BJhClQgKjPQrYVRg3rl4FBjtGUvPF7XkcBJmZJ7ASUs3XuMoDcM4Bo7D1Bm0MISP3K1uLd6P4cMRHwCWzLU5tMmzDasvgw2GESI2Oofi6p9JHGmaqk22Gx5x0LO3ojLJRhNFwVlHCD8i8LM7iiR4e1wk2VI/Zk6qnUmpkt2pLqIyCytQSWK2RPy95Sov18AHtE/LhVqWEJdJt3duBgRwIhxi45PV8i6XcyC2nT+3JVxLctSUXkKIB+gJ4jqj26DGoDW1QXwpOPW+fTqCWfkadcWMUA4GH4DwIDAQAB',
  minimum_chrome_version: '138',
  permissions: ['activeTab', 'scripting', 'storage', 'unlimitedStorage'],
  host_permissions: ['http://localhost:11434/*'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [],
  // No side_panel. The action click opens a full browser tab.
  // No default_popup — if a popup is declared, onClicked never fires.
  action: {
    default_title: 'Open Clarity',
    default_icon: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
  },
  icons: {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  },
  // options_ui with open_in_tab: true is the crxjs-recommended way to include
  // an additional HTML page in the build without using build.rollupOptions.input
  // (which has known issues with crxjs). Chrome's "Extension options" link opens
  // the app, and chrome.runtime.getURL('src/app/index.html') resolves correctly.
  options_ui: {
    page: 'src/app/index.html',
    open_in_tab: true,
  },
  content_security_policy: {
    // script-src 'self': extension pages only load same-origin scripts.
    // 'wasm-unsafe-eval': lets the NLI worker compile the bundled ONNX Runtime
    //   WebAssembly (dist/ort/). It allows WebAssembly compilation only, not
    //   JS eval()/new Function(); this is the only CSP relaxation allowed.
    // connect-src http://localhost:11434: Ollama API.
    // No 'unsafe-eval' — pdf.js v6 has no eval() code path, so none is needed.
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' http://localhost:11434;",
  },
  // Cross-origin isolation for the extension's pages (not a CSP change): it
  // gives the NLI worker SharedArrayBuffer, so ONNX Runtime's wasm runs on
  // NLI_WASM_THREADS threads (eval/checker/NLI_PERF.md). Everything the app
  // loads is same-origin, and Ollama answers CORS requests (OLLAMA_ORIGINS).
  // crxjs's manifest type lacks these two keys; @types/chrome has them.
  ...CROSS_ORIGIN_ISOLATION,
});
