import { firstSkipReason } from '@holiday/core';
import { isContributorStandIn, isFixturePhotoCopyright } from '../fixtures/copyright.js';
import type {
  CaptureGranularity,
  CopyrightClass,
  EntryMethod,
  HeadingMode,
  MatchClass,
  Precision,
  SkipReason,
  StreetViewSourceMode,
} from '@holiday/core';

/** Match-confidence thresholds (configuration; versioned with every discovery). */
export interface MatchThresholds {
  thresholdsVersion: string;
  autoStartDistanceM: number;
  confirmDistanceM: number;
  captureAgeYears: number;
  narrowFacadeM: number;
  discoveryBudgetMs: number;
}

export const DEFAULT_MATCH_THRESHOLDS: MatchThresholds = Object.freeze({
  thresholdsVersion: '1',
  autoStartDistanceM: 25,
  confirmDistanceM: 60,
  captureAgeYears: 5,
  narrowFacadeM: 7,
  discoveryBudgetMs: 6000,
});

/** Version of the viewpoint and match algorithm, recorded with every discovery. */
export const DISCOVERY_ALGORITHM_VERSION = '1';

export type SignalColor = 'green' | 'amber' | 'red';

export const TIER_A_SIGNAL_NAMES = [
  'scope',
  'blockedAddress',
  'multiUnit',
  'precision',
  'panoramaAvailability',
  'panoramaDistance',
  'headingBasis',
  'facadeWidth',
  'captureAge',
  'copyright',
  'entryMethod',
  'sourceMode',
  'providerState',
] as const;
export type TierASignalName = (typeof TIER_A_SIGNAL_NAMES)[number];

export interface TierASignal {
  name: TierASignalName;
  color: SignalColor;
  /** The skip reason a red signal contributes. */
  reason?: SkipReason;
}

/** Everything Tier A needs; no pixels and no address text. */
export interface MatchInputs {
  countryCode: string | null;
  blockedAddress: boolean;
  multiUnit: boolean;
  precision: Precision;
  partialMatch: boolean;
  /** SearchDestinations structure type; `GROUNDS` is amber. */
  structureType?: string | null;
  /** Metadata outcome of discovery. */
  discoveryStatus: 'ok' | 'no_imagery' | 'error';
  /** Radius at which the primary panorama was found (50, 100 or 200), null without one. */
  probeRadiusM: number | null;
  primaryDistanceM: number | null;
  headingMode: HeadingMode | null;
  facadeWidthM: number | null;
  attachedFacade: boolean;
  captureDate: string | null;
  captureGranularity: CaptureGranularity | null;
  copyrightClass: CopyrightClass | null;
  entryMethod: EntryMethod;
  sourceMode: StreetViewSourceMode;
  /** `discovery.autostart_paused`: report `auto_start` as `confirm`. */
  autostartPaused?: boolean;
  now: Date;
}

export interface MatchDecision {
  matchClass: MatchClass;
  /** Stored reason (includes `blocked_address`; project it before sending to clients). */
  reason: SkipReason | null;
  retryable: boolean;
  signals: TierASignal[];
  amber: TierASignalName[];
  red: SkipReason[];
  /** True when `auto_start` was reported as `confirm` because auto-start is paused. */
  autostartPaused: boolean;
  thresholdsVersion: string;
}

/**
 * Copyright class from the metadata copyright string: Google imagery names Google. A fixture
 * stand-in photograph ("Fixture photo: …") is classed with first-party imagery unless it is marked
 * as a contributor stand-in, so fixture places exercise the same rules as live imagery.
 */
export function copyrightClassOf(copyright: string | null | undefined): CopyrightClass {
  if (!copyright || !copyright.trim()) return 'unknown';
  if (isFixturePhotoCopyright(copyright)) {
    return isContributorStandIn(copyright) ? 'contributor' : 'google';
  }
  return /google/i.test(copyright) ? 'google' : 'contributor';
}

/** Capture granularity of a metadata `date` (`YYYY-MM`, `YYYY` or absent). */
export function captureGranularityOf(date: string | null | undefined): CaptureGranularity {
  if (!date) return 'none';
  if (/^\d{4}-\d{2}$/.test(date)) return 'month';
  if (/^\d{4}$/.test(date)) return 'year';
  return 'none';
}

/** Age in years of a capture date at `now` (start of the month or year), null when undated. */
export function captureAgeYears(date: string | null | undefined, now: Date): number | null {
  if (!date) return null;
  const match = /^(\d{4})(?:-(\d{2}))?$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) - 1 : 0;
  const captured = Date.UTC(year, month, 1);
  return (now.getTime() - captured) / (365.25 * 24 * 3600 * 1000);
}

/** Computes every Tier A signal with its color. */
export function tierASignals(
  input: MatchInputs,
  thresholds: MatchThresholds = DEFAULT_MATCH_THRESHOLDS,
): TierASignal[] {
  const signals: TierASignal[] = [];
  const add = (name: TierASignalName, color: SignalColor, reason?: SkipReason) =>
    signals.push(reason ? { name, color, reason } : { name, color });

  add(
    'scope',
    input.countryCode === 'US' ? 'green' : 'red',
    input.countryCode === 'US' ? undefined : 'out_of_scope',
  );
  add(
    'blockedAddress',
    input.blockedAddress ? 'red' : 'green',
    input.blockedAddress ? 'blocked_address' : undefined,
  );
  add('multiUnit', input.multiUnit ? 'red' : 'green', input.multiUnit ? 'multi_unit' : undefined);

  if (input.precision === 'low') add('precision', 'red', 'low_precision');
  else if (
    input.precision === 'interpolated' ||
    input.partialMatch ||
    input.structureType === 'GROUNDS'
  ) {
    add('precision', 'amber');
  } else add('precision', 'green');

  if (input.discoveryStatus === 'error') add('providerState', 'red', 'error');
  else add('providerState', 'green');

  if (input.discoveryStatus === 'no_imagery' || input.probeRadiusM === null) {
    if (input.discoveryStatus !== 'error') add('panoramaAvailability', 'red', 'no_imagery');
  } else {
    add('panoramaAvailability', input.probeRadiusM <= 50 ? 'green' : 'amber');
  }

  if (input.primaryDistanceM !== null) {
    if (input.primaryDistanceM > thresholds.confirmDistanceM) {
      add('panoramaDistance', 'red', 'no_imagery');
    } else {
      add(
        'panoramaDistance',
        input.primaryDistanceM <= thresholds.autoStartDistanceM ? 'green' : 'amber',
      );
    }
  }

  if (input.headingMode) add('headingBasis', input.headingMode === 'geometry' ? 'green' : 'amber');

  const narrow =
    input.facadeWidthM !== null &&
    input.facadeWidthM > 0 &&
    input.facadeWidthM < thresholds.narrowFacadeM;
  add('facadeWidth', narrow || input.attachedFacade ? 'amber' : 'green');

  if (input.discoveryStatus === 'ok') {
    const age = captureAgeYears(input.captureDate, input.now);
    const dated = input.captureGranularity === 'month' || input.captureGranularity === 'year';
    add(
      'captureAge',
      dated && age !== null && age <= thresholds.captureAgeYears ? 'green' : 'amber',
    );
    add('copyright', input.copyrightClass === 'google' ? 'green' : 'amber');
  }

  add('entryMethod', input.entryMethod === 'autocomplete' ? 'green' : 'amber');

  // The source mode is evaluated per discovered candidate, so it only applies when discovery
  // found imagery; a metadata error or no imagery is already red on its own signal.
  if (input.discoveryStatus === 'ok') {
    if (input.sourceMode === 'unavailable') add('sourceMode', 'red', 'no_imagery');
    else add('sourceMode', input.sourceMode === 'display_only' ? 'amber' : 'green');
  }

  return signals;
}

/**
 * Decision rules: any red signal → `skip_to_upload` with the first reason by precedence; no red
 * and no amber → `auto_start`; otherwise `confirm`. The hard rules (multi-unit, non-rooftop or
 * partial precision, contributor imagery, manual entry and `display_only` never auto-start) are
 * enforced by the signal colors and cannot be relaxed by thresholds.
 */
export function decideMatch(
  input: MatchInputs,
  thresholds: MatchThresholds = DEFAULT_MATCH_THRESHOLDS,
): MatchDecision {
  const signals = tierASignals(input, thresholds);
  const red = signals.flatMap((signal) =>
    signal.color === 'red' && signal.reason ? [signal.reason] : [],
  );
  const amber = signals.filter((signal) => signal.color === 'amber').map((signal) => signal.name);
  const reason = firstSkipReason(red);
  const base = { signals, amber, red, thresholdsVersion: thresholds.thresholdsVersion };
  if (reason) {
    return {
      ...base,
      matchClass: 'skip_to_upload',
      reason,
      retryable: reason === 'error',
      autostartPaused: false,
    };
  }
  if (amber.length === 0) {
    if (input.autostartPaused) {
      return {
        ...base,
        matchClass: 'confirm',
        reason: null,
        retryable: false,
        autostartPaused: true,
      };
    }
    return {
      ...base,
      matchClass: 'auto_start',
      reason: null,
      retryable: false,
      autostartPaused: false,
    };
  }
  return { ...base, matchClass: 'confirm', reason: null, retryable: false, autostartPaused: false };
}
