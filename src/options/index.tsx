import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { clearOldCache } from '../lib/storage/cache';

function Options() {
  const [customWords, setCustomWords] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [clearStatus, setClearStatus] = useState<'idle' | 'cleared' | 'error'>('idle');

  // Load persisted custom word list on mount
  useEffect(() => {
    chrome.storage.sync.get('customWords', (data) => {
      if (data.customWords) setCustomWords(data.customWords);
    });
  }, []);

  const handleSaveWords = async () => {
    try {
      await chrome.storage.sync.set({ customWords });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  };

  const handleClearCache = async () => {
    try {
      await clearOldCache();
      // Also nuke everything in local storage (all cache keys, not just expired ones)
      await chrome.storage.local.clear();
      setClearStatus('cleared');
      setTimeout(() => setClearStatus('idle'), 2000);
    } catch {
      setClearStatus('error');
    }
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '600px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Clarity Options</h1>

      <section>
        <h2>Custom Common Words</h2>
        <p style={{ color: '#555', fontSize: '0.9rem' }}>
          Words added here will not be counted as jargon in the readability report.
          Enter one word per line, or comma-separated.
        </p>
        <textarea
          rows={10}
          value={customWords}
          onChange={e => setCustomWords(e.target.value)}
          style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box', fontFamily: 'monospace' }}
          placeholder="quantum&#10;photosynthesis&#10;mitochondria"
        />
        <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button
            onClick={handleSaveWords}
            style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}
          >
            Save Words
          </button>
          {saveStatus === 'saved' && <span style={{ color: 'green' }}>✓ Saved</span>}
          {saveStatus === 'error' && <span style={{ color: 'red' }}>✗ Failed to save</span>}
        </div>
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Cache</h2>
        <p style={{ color: '#555', fontSize: '0.9rem' }}>
          Clears all cached readability scores and simplified text stored locally.
          The next page analysis will re-compute everything from scratch.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button
            onClick={handleClearCache}
            style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}
          >
            Clear Cache
          </button>
          {clearStatus === 'cleared' && <span style={{ color: 'green' }}>✓ Cache cleared</span>}
          {clearStatus === 'error' && <span style={{ color: 'red' }}>✗ Failed to clear</span>}
        </div>
      </section>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<Options />);
}
