import { useAppStore } from './appStore';
import { INITIAL_PROJECT_FLOW, useProjectStore } from './projectStore';
import { useShareStore } from './shares';

/**
 * Forgets everything this device keeps for the signed-in owner (share links, the continue
 * banner's project and the open project), after sign-out or account deletion, so the next
 * person on a shared device never sees it.
 */
export function clearOwnerLocalState(): void {
  useShareStore.getState().clear();
  const last = useAppStore.getState().lastProject;
  if (last) useAppStore.getState().forgetProject(last.id);
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
}
