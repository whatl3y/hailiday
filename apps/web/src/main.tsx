// The base stylesheet (tokens, then global rules) is the first import, so every feature
// stylesheet follows it in the bundle and wins ties of equal specificity.
import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { analytics } from './analytics';
import { startWebVitals } from './analytics/webVitals';
import { createAppRouter } from './app/routes';
import { bootstrapExperience } from './experience/load';
// The server-rendered landing panel uses the landing styles, so they ship in the entry stylesheet.
import './features/landing/landing.css';

const path = window.location.pathname;
const isSharePage = path.startsWith('/s/');

// The public share page needs no session or experience; everything else hydrates from the
// shell's inline JSON or fetches it.
if (!isSharePage) bootstrapExperience();

// Field performance for the landing, project and share pages, reported once when hidden.
startWebVitals(path, {
  track: (vitals) => analytics.track('web_vitals', vitals),
  flush: () => analytics.flush(true),
});

// The server-rendered region belongs to the landing page only. Elsewhere (the share page) the
// app renders its own markup, so the region is emptied and can never be adopted as a hero.
if (path !== '/') {
  const serverHero = document.getElementById('ssr-hero');
  if (serverHero) {
    serverHero.hidden = true;
    serverHero.replaceChildren();
  }
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={createAppRouter()} />
    </StrictMode>,
  );
}
