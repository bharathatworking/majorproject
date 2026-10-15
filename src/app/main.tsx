import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/opendyslexic';
import './app.css';
import App from './App';
import { getNliDevice } from '../lib/storage/nli-bench';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// fp16 NLI experiment (debug:nliDevice = 'webgpu-fp16' only): a lazy chunk,
// never loaded in a normal session
getNliDevice()
  .then(device => {
    if (device === 'webgpu-fp16') {
      return import('../lib/quality/nli-experiment').then(m => m.installNliExperiment());
    }
  })
  .catch(err => console.log('[Clarity] NLI experiment not installed', err));
