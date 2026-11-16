import {
  AllowanceSchema,
  ExperienceSchema,
  type Allowance,
  type CapabilityKey,
  type Experience,
} from '@hailiday/core';
import { ApiError } from '../api/errors';

/** The experience projection without the session-specific allowance snapshot. */
export type PublicExperience = Omit<Experience, 'allowance'>;

export interface ExperienceSnapshot {
  experience: PublicExperience;
  /**
   * The session's allowance from `GET /v1/experience`. Always null for the landing shell's
   * inline JSON, which is the public projection served before any session exists.
   */
  allowance: Allowance | null;
  /**
   * Capability keys (for example `image_editing`, `street_view_display`) that run in fixture
   * mode, from the payload's `fixtureCapabilities` (sent outside production only). Images from
   * these integrations carry the development "Fixture" badge.
   */
  fixtureCapabilities: CapabilityKey[];
}

const PublicExperienceSchema = ExperienceSchema.omit({ allowance: true });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalidPayload(): ApiError {
  return new ApiError({
    kind: 'invalid_response',
    status: null,
    code: null,
    details: {},
    requestId: null,
    retryAfterSeconds: null,
    message: 'The experience payload did not match the expected schema.',
  });
}

/** Validates an experience payload from the API or the landing shell. */
export function parseExperiencePayload(
  raw: unknown,
  options: { requireAllowance: boolean },
): ExperienceSnapshot {
  const record = asRecord(raw);
  if (!record) throw invalidPayload();
  const { allowance: rawAllowance, ...rest } = record;
  const parsed = PublicExperienceSchema.safeParse(rest);
  if (!parsed.success) throw invalidPayload();
  let allowance: Allowance | null = null;
  if (rawAllowance !== undefined && rawAllowance !== null) {
    const parsedAllowance = AllowanceSchema.safeParse(rawAllowance);
    if (parsedAllowance.success) allowance = parsedAllowance.data;
    else if (options.requireAllowance) throw invalidPayload();
  } else if (options.requireAllowance) {
    throw invalidPayload();
  }
  return {
    experience: parsed.data,
    allowance,
    fixtureCapabilities: parsed.data.fixtureCapabilities ?? [],
  };
}

/**
 * Reads the landing shell's `<script type="application/json" id="experience">`, if any. Any
 * allowance in it is ignored: the shell is rendered before the visitor's session exists, so the
 * real snapshot is fetched once the session does.
 */
export function readInlineExperience(doc: Document = document): ExperienceSnapshot | null {
  const text = doc.getElementById('experience')?.textContent;
  if (!text || !text.trim()) return null;
  try {
    const snapshot = parseExperiencePayload(JSON.parse(text), { requireAllowance: false });
    return { ...snapshot, allowance: null };
  } catch {
    return null;
  }
}
