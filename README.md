# Clarity — AI Reading Simplifier

A Chrome extension that rewrites any web page, pasted text, or PDF at **your** reading level using a local Ollama model. No text ever leaves your device.

---

## Features

| Feature | Details |
|---|---|
| **Page capture** | Click the toolbar icon to capture and analyze any web page |
| **Paste text** | Paste any text directly into the app |
| **PDF upload** | Drag-and-drop or browse for a text-based PDF |
| **Readability dashboard** | 8 grade-level metrics (FKGL, Gunning Fog, SMOG, Coleman-Liau, ARI, Dale-Chall, Flesch Ease, estimated grade) |
| **AI simplification** | Streaming paragraph-by-paragraph rewrite via Ollama |
| **Reading profile** | Target grade 1–16, age group, style, domain familiarity |
| **Click to reveal** | Every simplified paragraph shows the original on click |
| **Focus mode** | Non-hovered paragraphs dim so you focus on one at a time |
| **Dyslexia font** | Bundled OpenDyslexic (no CDN — works offline) |
| **Progress tracking** | Weekly trend chart of your target reading level; before/after grade comparison |
| **Custom word list** | Mark domain terms as "not jargon" |
| **Offline-first** | Everything runs locally — Ollama on `localhost:11434` |

---

## Requirements

- **Chrome** 138 or later (Manifest V3)
- **Node.js** 18+ and npm (for building from source)
- **Ollama** installed and running — https://ollama.com

---

## Quick start

### 1 — Install and pull the model

```powershell
# Install Ollama from https://ollama.com, then:
ollama pull qwen2.5:3b
ollama pull all-minilm   # meaning checker (optional, ~46 MB)
```

`all-minilm` is a small Sentence-BERT embedding model. Clarity uses it to check that each simplified paragraph keeps the original meaning, and retries a paragraph once if it doesn't. Without it, simplification still works, but no meaning scores are shown.

### 2 — Set OLLAMA_ORIGINS (required)

Chrome extensions run from a `chrome-extension://` origin. Ollama blocks cross-origin requests by default. You must set `OLLAMA_ORIGINS` to the extension's fixed ID **before** starting Ollama.

**Windows — PowerShell (run once, persists across reboots):**

```powershell
[System.Environment]::SetEnvironmentVariable(
  "OLLAMA_ORIGINS",
  "chrome-extension://emnnfgmpahidhdpdakmblphimmamckon",
  "User"
)
```

Then **fully close and restart Ollama** (kill it from the system tray, then reopen).

**macOS / Linux:**

```bash
# Add to ~/.zshrc or ~/.bashrc:
export OLLAMA_ORIGINS="chrome-extension://emnnfgmpahidhdpdakmblphimmamckon"
# Then restart Ollama:
pkill ollama && ollama serve
```

> [!IMPORTANT]
> The extension ID `emnnfgmpahidhdpdakmblphimmamckon` is fixed — it comes from the `key` field in `src/manifest.ts` and will not change when you reload the unpacked extension.

### 3 — Build the extension

```powershell
npm install
npm run build
```

This produces a `dist/` folder. `dist/` is not committed to git, so rebuild it after every clone or pull.

### 4 — Load in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `dist/` folder
4. The Clarity icon appears in your toolbar

### 5 — Use it

- **From a web page:** navigate to any article → click the Clarity icon → a Clarity tab opens (or is focused if already open)
- **From the app:** click **"New document"** in the sidebar → paste text or upload a PDF
- **Simplify:** go to the **Reading** tab → click **"Simplify now"** → text streams in paragraph by paragraph
- **Settings:** go to **Settings** to adjust your reading profile, display options, and custom vocabulary

---

## Development

```powershell
npm run build        # production build → dist/
npm run dev          # watch mode (hot-reload via crxjs)
npm test             # unit tests (Vitest)
npm run typecheck    # strict TypeScript check (tsc --noEmit)
```

### Project layout

```
src/
  app/                    # Full-tab React application
    components/           # Sidebar, DocumentList, Toast, NewDocDialog
    hooks/                # useDocuments, useRunState, useDisplayPrefs
    pages/                # Dashboard, Reading, Progress, Settings
  background/             # MV3 service worker (tab reuse, capture)
  content-scripts/        # Page extractor (Mozilla Readability)
  lib/
    input/                # paste.ts, pdf.ts — new document sources
    llm/                  # OllamaProvider (NDJSON streaming)
    metrics/              # Readability engine, word-set
    profile/              # resolveProfile, resolveTargetGrade
    prompt-builder/       # buildPrompt (system + user prompt)
    run/                  # runSimplification (the main AI loop)
    segmentation/         # segmentHtml (deterministic node IDs)
    storage/              # documents.ts, progress.ts, settings.ts
    utils/                # sha256, escapeHtml (shared by all input paths)
  types/                  # Shared TypeScript interfaces
  manifest.ts             # Chrome manifest (DO NOT touch the key field)
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **"Can't reach Ollama at localhost:11434"** | Start Ollama (`ollama serve`) |
| **"Ollama refused the request (403)"** | Set `OLLAMA_ORIGINS` (see Step 2 above) and **fully restart** Ollama |
| **"Model not found"** | Run `ollama pull qwen2.5:3b` |
| **"Install the meaning checker"** banner | Run `ollama pull all-minilm`. The run still finishes without it, just without meaning scores |
| **No text extracted from PDF** | The PDF is likely a scanned image — only text-based PDFs are supported |
| **Extension ID changed** | Never remove the `key` field from `src/manifest.ts` |
| **Sidebar chip shows "Not reachable"** | Ollama not running, or OLLAMA_ORIGINS not set correctly |

---

## Architecture notes

- **No side panel** — the toolbar icon opens (or focuses) one persistent Clarity tab
- **No eval** — pdf.js v6 has no eval code path; the CSP has no `'unsafe-eval'` and needs no relaxation
- **Write queue** — `documents.ts` serialises all storage writes to prevent read-modify-write races on the 10-document index
- **Deterministic node IDs** — segmenter produces `n0, n1, …` per call so stored results survive page reloads
- **Run loop at App level** — simplification streams continue even when navigating between tabs within the app
- **Weekly progress** — stored under `progress:weekly` in `chrome.storage.local`; 30-day rolling window; separate from documents so clearing docs doesn't reset your trend

---

## Privacy

All processing is local. The extension makes exactly two kinds of network calls:

1. `http://localhost:11434` — Ollama API (your machine only)
2. The active page's own origin — only for extraction via `chrome.scripting` (same as what the browser already loaded)

No analytics, no telemetry, no external API keys.
