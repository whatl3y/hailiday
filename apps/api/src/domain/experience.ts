import {
  EDITORIAL_TIMEZONE,
  SCENE_TYPES,
  UPLOAD_ACCEPTED_CONTENT_TYPES,
  catalogEntry,
  holidayNameKey,
  isCapabilityKey,
  isHolidayId,
  packOfferFor,
  pickerOrder,
  type Allowance,
  type CapabilityKey,
  type Example,
  type Experience,
  type ExperienceHoliday,
  type Hero,
  type HolidayId,
  type Rendition,
  type SceneType,
  type SceneTypeOffer,
} from '@hailiday/core';
import { capabilityMode, type Audience } from '@hailiday/server/capabilities';
import type { HeroAsset, HeroCropJson } from '@hailiday/server/db';
import type { ApiDeps } from '../deps.js';
import {
  currentOccurrence,
  editorialDate,
  enabledHolidayIds,
  holidayCalendar,
  occurrenceOf,
} from './holidays.js';

/** Terms version shown with the age line (legal deliverable version). */
export const TERMS_VERSION = '2026-11';
/** Rendition format preference for the single-format hero and example URLs. */
const FORMAT_PREFERENCE = ['webp', 'avif', 'jpeg', 'jpg', 'png'];

function renditionsOf(deps: Pick<ApiDeps, 'storage'>, crop: HeroCropJson | undefined): Rendition[] {
  if (!crop) return [];
  const formats = new Set(crop.renditions.map((rendition) => rendition.format));
  const format = FORMAT_PREFERENCE.find((candidate) => formats.has(candidate));
  return crop.renditions
    .filter((rendition) => rendition.format === format)
    .sort((a, b) => b.width - a.width)
    .map((rendition) => ({
      url: deps.storage.publicUrl(rendition.cdnPath),
      width: rendition.width,
      height: rendition.height,
    }));
}

function heroDto(deps: Pick<ApiDeps, 'storage'>, hero: HeroAsset): Hero {
  return {
    holidayId: hero.holidayId,
    sceneType: hero.sceneType,
    renditions: {
      landscape: renditionsOf(deps, hero.renditions.landscape),
      portrait: renditionsOf(deps, hero.renditions.portrait),
    },
    altKey: hero.altTextKey,
  };
}

/** The public part of the experience projection (everything but the session allowance). */
export interface PublicExperience extends Omit<Experience, 'allowance' | 'capabilities'> {
  /** The hero row behind `hero` (alt text and focal points for the landing shell). */
  heroAsset: HeroAsset | null;
  /** Identifies the promotion window (cache keys and ETags). */
  windowId: string;
}

/**
 * Builds the experience projection: the default holiday in the editorial timezone, the picker
 * list with each pack's offered scene types, the occurrence calendar of the current and next
 * year, the hero and examples, client configuration and legal info.
 */
export async function publicExperience(
  deps: ApiDeps,
  requestedHoliday: string | null | undefined,
): Promise<PublicExperience> {
  const now = deps.clock.now();
  const calendar = await holidayCalendar(deps);
  const today = editorialDate(now);
  const current = currentOccurrence(calendar.rows, now);
  const defaultHolidayId = current?.holidayId ?? null;
  const enabled = enabledHolidayIds(calendar.rows);
  const requestedHolidayId =
    requestedHoliday && isHolidayId(requestedHoliday) && enabled.includes(requestedHoliday)
      ? requestedHoliday
      : null;

  const holidays: ExperienceHoliday[] = [];
  for (const holidayId of pickerOrder(enabled, defaultHolidayId, today)) {
    const pack = deps.content.packFor(holidayId);
    if (!pack) continue;
    const occurrence = occurrenceOf(calendar.rows, holidayId, now);
    const sceneTypes: Partial<Record<SceneType, SceneTypeOffer>> = {};
    for (const sceneType of SCENE_TYPES) {
      const offer = packOfferFor(pack.pack, sceneType);
      if (offer) sceneTypes[sceneType] = offer;
    }
    const pinned = occurrence?.packVersionId
      ? calendar.packVersions.get(occurrence.packVersionId)
      : undefined;
    holidays.push({
      id: holidayId,
      nameKey: holidayNameKey(holidayId),
      isDefault: holidayId === defaultHolidayId,
      journeyEmphasis: pack.pack.journeyEmphasis ?? catalogEntry(holidayId).journeyEmphasis,
      inWindow: holidayId === defaultHolidayId,
      windowStart: occurrence?.promotionStart ?? null,
      windowEnd: occurrence?.promotionEnd ?? null,
      packVersion: pinned?.version ?? calendar.published.get(holidayId) ?? pack.version,
      sceneTypes,
    });
  }

  const year = Number(today.slice(0, 4));
  const calendarEntries = calendar.rows
    .filter((row) => row.year === year || row.year === year + 1)
    .map((row) => ({
      occurrenceKey: row.occurrenceKey,
      holidayId: row.holidayId,
      promotionStart: row.promotionStart,
      promotionEnd: row.promotionEnd,
    }));

  const heroes = await deps.db
    .selectFrom('heroAssets')
    .selectAll()
    .where('active', '=', true)
    .execute();
  const heroById = new Map(heroes.map((hero) => [hero.id, hero]));
  let heroAsset: HeroAsset | null = null;
  if (current) {
    heroAsset =
      (current.heroAssetId ? heroById.get(current.heroAssetId) : undefined) ??
      heroes.find((hero) => hero.holidayId === current.holidayId) ??
      null;
  }
  heroAsset ??= heroes.find((hero) => hero.holidayId === null) ?? null;

  const exampleRows = await deps.db
    .selectFrom('exampleAssets')
    .selectAll()
    .where('active', '=', true)
    .orderBy('assetKey')
    .execute();
  const order = new Map(holidays.map((holiday, index) => [holiday.id, index]));
  const examples: Example[] = exampleRows
    .filter((row) => order.has(row.holidayId))
    .sort((a, b) => (order.get(a.holidayId) ?? 0) - (order.get(b.holidayId) ?? 0))
    .map((row) => ({
      holidayId: row.holidayId,
      sceneType: row.sceneType,
      style: row.style,
      lightingMode: row.lightingMode,
      beforeUrl: deps.storage.publicUrl(row.beforeCdnPath),
      afterUrl: deps.storage.publicUrl(row.afterCdnPath),
      width: row.width,
      height: row.height,
      captionKey: row.captionKey,
    }));

  return {
    defaultHolidayId,
    requestedHolidayId,
    editorialTimezone: EDITORIAL_TIMEZONE,
    offSeason: defaultHolidayId === null,
    holidays,
    calendar: calendarEntries,
    hero: heroAsset ? heroDto(deps, heroAsset) : null,
    heroAsset,
    windowId: current?.occurrenceKey ?? `off-season.${today.slice(0, 4)}`,
    examples,
    clientConfig: {
      autocompleteMinChars: 3,
      autocompleteDebounceMs: 250,
      uploadMaxBytes: deps.config.storage.uploadMaxBytes,
      uploadAcceptedTypes: [...UPLOAD_ACCEPTED_CONTENT_TYPES],
      pollRenderMs: await deps.settings.get('poll.render_ms'),
      pollUploadMs: await deps.settings.get('poll.upload_ms'),
      retention: {
        timeBasedDeletion: await deps.settings.get('retention.time_based_deletion'),
      },
    },
    legal: {
      termsVersion: TERMS_VERSION,
      ageLineKey: 'landing.ageLine',
      termsUrl: '/terms',
      privacyUrl: '/privacy',
    },
  };
}

/**
 * The capability keys whose evaluated state for the audience is `fixture`, so the client can badge
 * stand-in imagery. Undefined in production, where the field is omitted.
 */
export async function fixtureCapabilitiesFor(
  deps: Pick<ApiDeps, 'config' | 'capabilities'>,
  audience: Audience,
): Promise<CapabilityKey[] | undefined> {
  if (deps.config.isProduction) return undefined;
  const rows = await deps.capabilities.list('US');
  return rows
    .filter((row) => capabilityMode(row.state, audience, deps.config.appEnv) === 'fixture')
    .map((row) => row.capability)
    .filter(isCapabilityKey);
}

/** The full `GET /v1/experience` payload for an audience and allowance. */
export async function experienceFor(
  deps: ApiDeps,
  input: { requestedHoliday?: string | null; audience: Audience; allowance: Allowance },
): Promise<Experience> {
  const base = await publicExperience(deps, input.requestedHoliday);
  const { heroAsset: _heroAsset, windowId: _windowId, ...rest } = base;
  const fixtureCapabilities = await fixtureCapabilitiesFor(deps, input.audience);
  return {
    ...rest,
    capabilities: await deps.capabilities.publicProjection('US', input.audience),
    ...(fixtureCapabilities ? { fixtureCapabilities } : {}),
    allowance: input.allowance,
  };
}

export function isEnabledHoliday(
  experience: Pick<Experience, 'holidays'>,
  holidayId: HolidayId,
): boolean {
  return experience.holidays.some((holiday) => holiday.id === holidayId);
}
