import { z } from 'zod';
import type { HolidayId, LightingMode, Style } from './content.js';
import { HolidayIdSchema, LightingModeSchema, StyleSchema } from './content.js';

/** `MAJOR.MINOR.PATCH` with non-negative integers and no leading zeros. */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAJOR_MINOR_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const PackVersionSchema = z.string().regex(SEMVER_PATTERN, 'Expected MAJOR.MINOR.PATCH');
export type PackVersion = z.infer<typeof PackVersionSchema>;

export const PackMajorMinorSchema = z.string().regex(MAJOR_MINOR_PATTERN, 'Expected MAJOR.MINOR');

/** Reduces a full pack version to the `MAJOR.MINOR` that participates in the variant key. */
export function packMajorMinor(holidayPackVersion: string): string {
  const match = SEMVER_PATTERN.exec(holidayPackVersion);
  if (match) return `${match[1]}.${match[2]}`;
  if (MAJOR_MINOR_PATTERN.test(holidayPackVersion)) return holidayPackVersion;
  throw new RangeError(`Invalid holiday pack version: ${holidayPackVersion}`);
}

/** Compares two `MAJOR.MINOR.PATCH` versions numerically. */
export function comparePackVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function parseSemver(version: string): [number, number, number] {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new RangeError(`Invalid version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export const VARIANT_KEY_SEPARATOR = '|';

export interface VariantKeyInput {
  sourceAssetId: string;
  holidayId: HolidayId;
  style: Style;
  lightingMode: LightingMode;
  /** Full `MAJOR.MINOR.PATCH` (or an already reduced `MAJOR.MINOR`). */
  holidayPackVersion: string;
  compilerVersion: string;
}

export interface VariantKeyParts extends Omit<VariantKeyInput, 'holidayPackVersion'> {
  packMajorMinor: string;
}

/**
 * The identity and cache key of a variant:
 * `sourceAssetId|holidayId|style|lightingMode|MAJOR.MINOR|compilerVersion`.
 * Matches the generated `variant_key` column.
 */
export function variantKey(input: VariantKeyInput): string {
  for (const [name, value] of [
    ['sourceAssetId', input.sourceAssetId],
    ['compilerVersion', input.compilerVersion],
  ] as const) {
    if (value.length === 0 || value.includes(VARIANT_KEY_SEPARATOR)) {
      throw new RangeError(`Invalid ${name} for a variant key: ${value}`);
    }
  }
  return [
    input.sourceAssetId,
    HolidayIdSchema.parse(input.holidayId),
    StyleSchema.parse(input.style),
    LightingModeSchema.parse(input.lightingMode),
    packMajorMinor(input.holidayPackVersion),
    input.compilerVersion,
  ].join(VARIANT_KEY_SEPARATOR);
}

/** Splits a variant key back into its parts, or returns null when it is malformed. */
export function parseVariantKey(key: string): VariantKeyParts | null {
  const parts = key.split(VARIANT_KEY_SEPARATOR);
  if (parts.length !== 6) return null;
  const [sourceAssetId, holidayId, style, lightingMode, majorMinor, compilerVersion] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const holiday = HolidayIdSchema.safeParse(holidayId);
  const styleResult = StyleSchema.safeParse(style);
  const lighting = LightingModeSchema.safeParse(lightingMode);
  if (
    !sourceAssetId ||
    !compilerVersion ||
    !holiday.success ||
    !styleResult.success ||
    !lighting.success ||
    !MAJOR_MINOR_PATTERN.test(majorMinor)
  ) {
    return null;
  }
  return {
    sourceAssetId,
    holidayId: holiday.data,
    style: styleResult.data,
    lightingMode: lighting.data,
    packMajorMinor: majorMinor,
    compilerVersion,
  };
}
