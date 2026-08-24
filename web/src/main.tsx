import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
// Sets window.crateHost — the surface installed plugins are built against. A side-effect
// import, placed before App so the host exists before anything could import a plugin.
import './plugins/host.js';
import { App } from './App.js';
import { PlayerProvider } from './player.js';
import { ErrorBoundary, installGlobalErrorReporting } from './boundary.js';

// Installed before render, so a throw during the first paint is still reported.
installGlobalErrorReporting();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The boundary is outside the player so a crash in a view does not tear down the
        audio element with it — the music keeps playing while the page recovers. */}
    <PlayerProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </PlayerProvider>
  </StrictMode>,
);
