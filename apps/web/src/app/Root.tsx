import { Outlet, ScrollRestoration } from 'react-router';
import { GlobalSheets } from '../ui/GlobalSheets';
import { RouteAnnouncer } from '../ui/RouteAnnouncer';

/**
 * The app frame: the routed page, the sheets that can open from anywhere and the route-change
 * announcer that titles and focuses each new page.
 */
export function Root() {
  return (
    <>
      <Outlet />
      <GlobalSheets />
      <RouteAnnouncer />
      <ScrollRestoration />
    </>
  );
}
