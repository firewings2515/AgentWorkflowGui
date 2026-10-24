import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { readTheme } from './theme';

// Apply the stored palette before React's first render (no inline CSP exception).
document.documentElement.dataset.theme = readTheme();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
