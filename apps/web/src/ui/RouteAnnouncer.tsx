import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { focusMainContent } from './routeFocus';

/**
 * Announces each client-side route change through a polite live region (the new page's
 * document title) and moves focus to the new page. The first page load is left to the
 * browser. Pages set their titles in their own effects, which run before this one.
 */
export function RouteAnnouncer() {
  const { pathname } = useLocation();
  const handled = useRef(pathname);
  const count = useRef(0);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (handled.current === pathname) return;
    handled.current = pathname;
    count.current += 1;
    // A trailing no-break space on alternate changes makes a repeated title a new announcement.
    setMessage(`${document.title}${count.current % 2 === 0 ? ' ' : ''}`);
    focusMainContent();
  }, [pathname]);

  return (
    <div className="route-announcer sr-only" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
