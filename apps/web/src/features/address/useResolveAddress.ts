import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { GeocodeCandidate, Project } from '@hailiday/core';
import { resolveAddress } from '../../api/endpoints';
import { presentError } from '../../api/present';
import type { CopyKey } from '../../copy';
import { currentHolidayId, useAppStore } from '../../state/appStore';
import type { AddressSelection } from './AddressCombobox';

/** Router state handed to the project page; it never enters the URL. */
export interface ProjectRouteState {
  project?: Project;
  displayAddress?: string | null;
  entry?: 'autocomplete' | 'manual' | 'upload';
  /** Open the upload step directly (for example "Upload a photo instead" on a project). */
  openUpload?: boolean;
}

export interface ResolveMessage {
  key: CopyKey;
  text: string;
  tone: 'error' | 'notice';
}

/** Resolves a chosen suggestion or manual candidate into a project and opens it. */
export function useResolveAddress() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ResolveMessage | null>(null);

  async function run(body: Parameters<typeof resolveAddress>[0], entry: 'autocomplete' | 'manual') {
    setBusy(true);
    setMessage(null);
    try {
      const project = await resolveAddress(body);
      const state = useAppStore.getState();
      state.setAllowance(project.allowance);
      state.rememberProject(project.id);
      const routeState: ProjectRouteState = {
        project,
        displayAddress: project.property?.formattedAddress ?? null,
        entry,
      };
      navigate(`/p/${project.id}`, { state: routeState });
    } catch (error) {
      const inline = presentError(error, () => void run(body, entry));
      if (inline) setMessage({ key: inline.key, text: inline.message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function holidayParam() {
    const holidayId = currentHolidayId(useAppStore.getState());
    return holidayId ? { holidayId } : {};
  }

  return {
    busy,
    message,
    clearMessage: () => setMessage(null),
    resolveSuggestion: (selection: AddressSelection) =>
      run(
        {
          placeId: selection.suggestion.placeId,
          sessionToken: selection.sessionToken,
          ...holidayParam(),
        },
        'autocomplete',
      ),
    resolveCandidate: (candidate: GeocodeCandidate) =>
      run({ candidateId: candidate.candidateId, ...holidayParam() }, 'manual'),
  };
}
