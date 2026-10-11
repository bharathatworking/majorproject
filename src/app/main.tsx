import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/opendyslexic';
import './app.css';
import App from './App';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
