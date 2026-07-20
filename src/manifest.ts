import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: "Clarity",
  version: "1.0.0",
  description: "Read anything, at any level.",
  minimum_chrome_version: "138",
  permissions: ["activeTab", "scripting", "storage", "sidePanel"],
  host_permissions: ["http://localhost:11434/*"],
  background: { service_worker: "src/background/index.ts", type: "module" },
  content_scripts: [],
  side_panel: { default_path: "src/sidepanel/index.html" },
  action: {
    default_title: "Open Clarity",
    default_icon: {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  icons: {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true
  },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'; connect-src 'self' http://localhost:11434;"
  }
});
