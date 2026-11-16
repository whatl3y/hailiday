import { createBrowserRouter, type RouteObject } from 'react-router';
import { AccountPage } from '../features/account/AccountPage';
import { PlacesPage } from '../features/account/PlacesPage';
import { VerifyPage } from '../features/account/VerifyPage';
import { GalleryPage } from '../features/gallery/GalleryPage';
import { LandingPage } from '../features/landing/LandingPage';
import { LegalPage, NotFoundPage } from '../features/legal/LegalPage';
import { LEGAL_PAGES, type LegalPageId } from '../features/legal/pages';
import { ProjectRoute } from '../features/project/ProjectPage';
import { OptOutPage } from '../features/report/OptOutPage';
import { SharePage } from '../features/share/SharePage';
import { UploadEntryPage } from '../features/upload/UploadEntryPage';
import { Root } from './Root';

const legalRoutes: RouteObject[] = (Object.keys(LEGAL_PAGES) as LegalPageId[]).map((page) => ({
  path: LEGAL_PAGES[page].path,
  element: <LegalPage page={page} />,
}));

/**
 * Client routes. Project identifiers are opaque; no route or URL ever carries an address.
 * `/s/:token` is server-rendered first; the app then takes over from the inline share data.
 */
export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/upload', element: <UploadEntryPage /> },
      { path: '/p/:projectId', element: <ProjectRoute /> },
      { path: '/places', element: <PlacesPage /> },
      { path: '/gallery', element: <GalleryPage /> },
      { path: '/account', element: <AccountPage /> },
      { path: '/auth/verify', element: <VerifyPage /> },
      { path: '/dont-decorate-my-home', element: <OptOutPage /> },
      { path: '/s/:token', element: <SharePage /> },
      ...legalRoutes,
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
