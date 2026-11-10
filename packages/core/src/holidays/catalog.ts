import type {
  HolidayId,
  HolidayReleaseStatus,
  JourneyEmphasis,
  SceneType,
} from '../types/content.js';
import { HOLIDAY_IDS, SCENE_TYPES } from '../types/content.js';

/** One holiday in the US Release catalog. */
export interface HolidayCatalogEntry {
  holidayId: HolidayId;
  displayName: string;
  /** Copy key of the display name. */
  nameKey: `holiday.${HolidayId}`;
  status: HolidayReleaseStatus;
  journeyEmphasis: JourneyEmphasis;
  sceneTypes: readonly SceneType[];
  /** Tie-break for overlapping promotion windows; lower wins. */
  editorialPriority: number;
  /** Whether the occurrence is enabled by default; optional packs start disabled. */
  enabledByDefault: boolean;
}

export const US_HOLIDAY_CATALOG: readonly HolidayCatalogEntry[] = [
  {
    holidayId: 'halloween',
    displayName: 'Halloween',
    nameKey: 'holiday.halloween',
    status: 'release',
    journeyEmphasis: 'exterior',
    sceneTypes: SCENE_TYPES,
    editorialPriority: 10,
    enabledByDefault: true,
  },
  {
    holidayId: 'thanksgiving_us',
    displayName: 'Thanksgiving',
    nameKey: 'holiday.thanksgiving_us',
    status: 'release',
    journeyEmphasis: 'interior',
    sceneTypes: SCENE_TYPES,
    editorialPriority: 10,
    enabledByDefault: true,
  },
  {
    holidayId: 'christmas',
    displayName: 'Christmas',
    nameKey: 'holiday.christmas',
    status: 'release',
    journeyEmphasis: 'balanced',
    sceneTypes: SCENE_TYPES,
    editorialPriority: 10,
    enabledByDefault: true,
  },
  {
    holidayId: 'new_years_eve',
    displayName: "New Year's Eve",
    nameKey: 'holiday.new_years_eve',
    status: 'optional',
    journeyEmphasis: 'balanced',
    sceneTypes: ['house_exterior', 'balcony', 'interior'],
    editorialPriority: 20,
    enabledByDefault: false,
  },
];

/** Holidays enabled unless configuration says otherwise. */
export const DEFAULT_ENABLED_HOLIDAY_IDS: readonly HolidayId[] = US_HOLIDAY_CATALOG.filter(
  (entry) => entry.enabledByDefault,
).map((entry) => entry.holidayId);

/** Regions with a catalog in this release. */
export const SUPPORTED_REGIONS = ['US'] as const;

export function catalogEntry(holidayId: HolidayId): HolidayCatalogEntry {
  const entry = US_HOLIDAY_CATALOG.find((candidate) => candidate.holidayId === holidayId);
  if (!entry) throw new RangeError(`Unknown holiday: ${holidayId}`);
  return entry;
}

export function holidayNameKey(holidayId: HolidayId): `holiday.${HolidayId}` {
  return catalogEntry(holidayId).nameKey;
}

export function isHolidayId(value: unknown): value is HolidayId {
  return typeof value === 'string' && (HOLIDAY_IDS as readonly string[]).includes(value);
}
