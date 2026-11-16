import { create } from 'zustand';
import {
  HOLIDAY_IDS,
  isHolidayId,
  localDateIn,
  parseHolidayDeepLink,
  pickerOrder,
  recomputeClientDefault,
  type Allowance,
  type AllowanceScope,
  type CapabilityKey,
  type HolidayId,
} from '@hailiday/core';
import type { ExperienceSnapshot, PublicExperience } from '../experience/payload';
import { STORAGE_KEYS, readStored, writeStored } from './persist';

export type SheetState =
  | { kind: 'allowance'; scope: AllowanceScope; resetsAt: string | null }
  | { kind: 'capacity'; retryAfterSeconds: number; onRetry: (() => void) | null }
  | { kind: 'examples' };

export interface LastProject {
  id: string;
  at: number;
}

export interface AppState {
  experience: PublicExperience | null;
  experienceStatus: 'idle' | 'loading' | 'ready' | 'error';
  allowance: Allowance | null;
  /** Capabilities running in fixture mode (outside production only). */
  fixtureCapabilities: CapabilityKey[];
  /** The visitor's timezone default (precedence step 2), recomputed on the client. */
  clientDefaultHolidayId: HolidayId | null;
  /** Holidays in picker order: the in-window default first, then by next celebration. */
  pickerHolidayIds: HolidayId[];
  /** A deliberate choice in this session (picker or project); persists across addresses. */
  explicitHolidayId: HolidayId | null;
  deepLinkHolidayId: HolidayId | null;
  attested: boolean;
  budgetPaused: boolean;
  sheet: SheetState | null;
  lastProject: LastProject | null;

  applyExperience(snapshot: ExperienceSnapshot, now: Date, timeZone: string): void;
  setExperienceStatus(status: AppState['experienceStatus']): void;
  setDeepLink(raw: string | null): void;
  chooseHoliday(holidayId: HolidayId): void;
  setAllowance(allowance: Allowance | null): void;
  setAttested(value: boolean): void;
  setBudgetPaused(value: boolean): void;
  openSheet(sheet: SheetState): void;
  closeSheet(): void;
  rememberProject(id: string): void;
  forgetProject(id: string): void;
}

function readExplicit(): HolidayId | null {
  const stored = readStored('session', STORAGE_KEYS.explicitHoliday);
  return isHolidayId(stored) ? stored : null;
}

function readLastProject(): LastProject | null {
  const raw = readStored('local', STORAGE_KEYS.lastProject);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LastProject>;
    return typeof parsed.id === 'string' && typeof parsed.at === 'number'
      ? { id: parsed.id, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

export const useAppStore = create<AppState>()((set, get) => ({
  experience: null,
  experienceStatus: 'idle',
  allowance: null,
  fixtureCapabilities: [],
  clientDefaultHolidayId: null,
  pickerHolidayIds: [],
  explicitHolidayId: readExplicit(),
  deepLinkHolidayId: null,
  attested: readStored('session', STORAGE_KEYS.attested) === '1',
  budgetPaused: false,
  sheet: null,
  lastProject: readLastProject(),

  applyExperience(snapshot, now, timeZone) {
    const { experience } = snapshot;
    const ids = experience.holidays.map((holiday) => holiday.id);
    const recomputed = recomputeClientDefault({
      serverDefaultHolidayId: experience.defaultHolidayId,
      calendar: experience.calendar,
      instant: now,
      timeZone,
    });
    const clientDefault =
      recomputed.holidayId && ids.includes(recomputed.holidayId) ? recomputed.holidayId : null;
    const order = pickerOrder(ids, clientDefault, localDateIn(now, timeZone));
    set({
      experience,
      experienceStatus: 'ready',
      allowance: snapshot.allowance ?? get().allowance,
      fixtureCapabilities: snapshot.fixtureCapabilities,
      clientDefaultHolidayId: clientDefault,
      pickerHolidayIds: order,
      budgetPaused: (snapshot.allowance ?? get().allowance)?.gate === 'budget_paused',
    });
  },
  setExperienceStatus(status) {
    set({ experienceStatus: status });
  },
  setDeepLink(raw) {
    set({ deepLinkHolidayId: parseHolidayDeepLink(raw, HOLIDAY_IDS) });
  },
  chooseHoliday(holidayId) {
    writeStored('session', STORAGE_KEYS.explicitHoliday, holidayId);
    set({ explicitHolidayId: holidayId });
  },
  setAllowance(allowance) {
    if (!allowance) return;
    // The latest snapshot decides the banner, so it clears once generation resumes.
    set({ allowance, budgetPaused: allowance.gate === 'budget_paused' });
  },
  setAttested(value) {
    writeStored('session', STORAGE_KEYS.attested, value ? '1' : null);
    set({ attested: value });
  },
  setBudgetPaused(value) {
    set({ budgetPaused: value });
  },
  openSheet(sheet) {
    set({ sheet });
  },
  closeSheet() {
    set({ sheet: null });
  },
  rememberProject(id) {
    const lastProject = { id, at: Date.now() };
    writeStored('local', STORAGE_KEYS.lastProject, JSON.stringify(lastProject));
    set({ lastProject });
  },
  forgetProject(id) {
    if (get().lastProject?.id !== id) return;
    writeStored('local', STORAGE_KEYS.lastProject, null);
    set({ lastProject: null });
  },
}));

/** Holidays the experience offers (enabled occurrences only). */
export function enabledHolidayIds(state: Pick<AppState, 'experience'>): HolidayId[] {
  return state.experience?.holidays.map((holiday) => holiday.id) ?? [];
}

/**
 * The selected holiday by precedence: an explicit choice, then a valid deep link, then the
 * visitor's in-window default. Null means off-season with nothing chosen.
 */
export function currentHolidayId(
  state: Pick<
    AppState,
    'experience' | 'explicitHolidayId' | 'deepLinkHolidayId' | 'clientDefaultHolidayId'
  >,
): HolidayId | null {
  const enabled = enabledHolidayIds(state);
  for (const candidate of [state.explicitHolidayId, state.deepLinkHolidayId]) {
    if (candidate && enabled.includes(candidate)) return candidate;
  }
  return state.clientDefaultHolidayId;
}

/** Whether no holiday window is open for the visitor (off-season). */
export function isOffSeason(
  state: Pick<AppState, 'clientDefaultHolidayId' | 'experience'>,
): boolean {
  return state.experience !== null && state.clientDefaultHolidayId === null;
}

/** Whether the visitor has a holiday by explicit choice (picker, project or deep link). */
export function hasChosenHoliday(
  state: Pick<AppState, 'experience' | 'explicitHolidayId' | 'deepLinkHolidayId'>,
): boolean {
  const enabled = enabledHolidayIds(state);
  return [state.explicitHolidayId, state.deepLinkHolidayId].some(
    (candidate) => candidate !== null && enabled.includes(candidate),
  );
}

export function useCurrentHolidayId(): HolidayId | null {
  return useAppStore(currentHolidayId);
}
