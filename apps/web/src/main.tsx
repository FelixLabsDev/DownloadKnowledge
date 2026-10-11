import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ToastProvider } from './components/ui';
import { startDb } from './db/client';
import './index.css';
import { applyTheme } from './lib/utils';

applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
startDb();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
