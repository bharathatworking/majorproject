import { useState, useEffect, useCallback } from 'react';
import type { DisplayPrefs } from '../../types';

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
  dyslexiaFont: false,
  textSize: 'normal',
  focusMode: false,
};

const STORAGE_KEY = 'displayPrefs';

/**
 * Reads and persists the user's reading display preferences.
 * State is live-synced via chrome.storage.onChanged so changes made in the
 * Settings page (Phase 3) immediately affect the Reading page without a reload.
 */
export function useDisplayPrefs() {
  const [prefs, setPrefs] = useState<DisplayPrefs>(DEFAULT_DISPLAY_PREFS);

  // Initial load
  useEffect(() => {
    chrome.storage.sync.get<{ [STORAGE_KEY]?: Partial<DisplayPrefs> }>(STORAGE_KEY).then(data => {
      if (data[STORAGE_KEY]) {
        setPrefs({ ...DEFAULT_DISPLAY_PREFS, ...data[STORAGE_KEY] });
      }
    });
  }, []);

  // Live sync
  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'sync' && STORAGE_KEY in changes) {
        setPrefs({ ...DEFAULT_DISPLAY_PREFS, ...(changes[STORAGE_KEY].newValue ?? {}) });
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const updatePrefs = useCallback(async (patch: Partial<DisplayPrefs>) => {
    setPrefs(prev => {
      const next = { ...prev, ...patch };
      chrome.storage.sync.set({ [STORAGE_KEY]: next });
      return next;
    });
  }, []);

  return { prefs, updatePrefs };
}
