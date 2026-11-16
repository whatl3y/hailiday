import type { ProjectRouteState } from '../address/useResolveAddress';

/**
 * The route state to keep in the history entry once the project page has opened. The handed-over
 * project and the request to open the upload step describe the place as it was when the entry
 * was made, so they are used once: a reload, or a return through history, reads the project
 * again and follows the look being made. Everything else in the state stays. Undefined when the
 * entry needs no change; null when nothing is left to keep.
 */
export function routeStateAfterOpen(state: unknown): object | null | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  if (!('project' in state) && !('openUpload' in state)) return undefined;
  const { project: _project, openUpload: _openUpload, ...kept } = state as ProjectRouteState;
  return Object.keys(kept).length > 0 ? kept : null;
}
