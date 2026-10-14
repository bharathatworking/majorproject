/**
 * In-memory chrome.* mock for unit tests running in Vitest's node environment.
 *
 * Covers only what Clarity's lib modules use: chrome.storage.{local,sync,
 * session} get/set/remove/clear, storage.onChanged listener registration, and
 * runtime.id. Values are deep-copied on the way in and out (structuredClone),
 * matching real chrome.storage serialization so tests can't accidentally rely
 * on shared object references.
 *
 * Usage: `const mock = installChromeMock();` in beforeEach; inspect stored
 * values through `mock.areas.local` etc. Vitest's unstubAllGlobals (or the
 * next install) replaces it.
 */

import { vi } from 'vitest';

// ─── Storage area ─────────────────────────────────────────────────────────────

type Keys = string | string[] | Record<string, unknown> | null | undefined;

export class MemoryStorageArea {
  readonly data = new Map<string, unknown>();

  async get(keys?: Keys): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (keys === null || keys === undefined) {
      for (const [k, v] of this.data) out[k] = structuredClone(v);
      return out;
    }
    if (typeof keys === 'string' || Array.isArray(keys)) {
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
      }
      return out;
    }
    // Object form: keys with defaults for missing entries
    for (const [k, fallback] of Object.entries(keys)) {
      out[k] = this.data.has(k) ? structuredClone(this.data.get(k)) : fallback;
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const k of typeof keys === 'string' ? [keys] : keys) this.data.delete(k);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }
}

// ─── Chrome mock ──────────────────────────────────────────────────────────────

export interface ChromeMock {
  areas: { local: MemoryStorageArea; sync: MemoryStorageArea; session: MemoryStorageArea };
  chrome: typeof chrome;
}

export const MOCK_EXTENSION_ID = 'emnnfgmpahidhdpdakmblphimmamckon';

export function createChromeMock(): ChromeMock {
  const areas = {
    local: new MemoryStorageArea(),
    sync: new MemoryStorageArea(),
    session: new MemoryStorageArea(),
  };
  const mock = {
    storage: {
      ...areas,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: MOCK_EXTENSION_ID },
  };
  // Only the members above exist; the cast lets lib code type-check against
  // the real @types/chrome surface.
  return { areas, chrome: mock as unknown as typeof chrome };
}

/** Creates a fresh mock and installs it as the global `chrome`. */
export function installChromeMock(): ChromeMock {
  const mock = createChromeMock();
  vi.stubGlobal('chrome', mock.chrome);
  return mock;
}
