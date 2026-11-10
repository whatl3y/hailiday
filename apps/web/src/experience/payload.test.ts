import { describe, expect, it } from 'vitest';
import { isFixtureImage } from '../ui/fixture';
import { allowance } from '../test/fixtures';
import { parseExperiencePayload, readInlineExperience } from './payload';

const experience = {
  defaultHolidayId: 'thanksgiving_us',
  requestedHolidayId: null,
  editorialTimezone: 'America/New_York',
  offSeason: false,
  holidays: [
    {
      id: 'thanksgiving_us',
      nameKey: 'holiday.thanksgiving_us',
      isDefault: true,
      journeyEmphasis: 'interior',
      inWindow: true,
      windowStart: '2026-11-01',
      windowEnd: '2026-11-26',
      packVersion: '1.0.0',
      sceneTypes: {},
    },
  ],
  calendar: [
    {
      occurrenceKey: 'thanksgiving_us.US.2026',
      holidayId: 'thanksgiving_us',
      promotionStart: '2026-11-01',
      promotionEnd: '2026-11-26',
    },
  ],
  hero: null,
  examples: [],
  capabilities: {
    addressLookup: true,
    streetViewAi: false,
    uploads: true,
    sharing: true,
    commerce: false,
  },
  clientConfig: {
    autocompleteMinChars: 3,
    autocompleteDebounceMs: 250,
    uploadMaxBytes: 26214400,
    uploadAcceptedTypes: ['image/jpeg'],
    pollRenderMs: 3000,
    pollUploadMs: 2000,
  },
  legal: {
    termsVersion: '2026-11',
    ageLineKey: 'landing.ageLine',
    termsUrl: '/terms',
    privacyUrl: '/privacy',
  },
};

describe('experience payload', () => {
  it('accepts the shell JSON without an allowance and requires one from the API', () => {
    expect(parseExperiencePayload(experience, { requireAllowance: false }).allowance).toBeNull();
    expect(() => parseExperiencePayload(experience, { requireAllowance: true })).toThrow();
  });

  it('reads the typed fixture capability list, and none when it is omitted', () => {
    const raw = { ...experience, fixtureCapabilities: ['image_editing', 'street_view_display'] };
    expect(parseExperiencePayload(raw, { requireAllowance: false }).fixtureCapabilities).toEqual([
      'image_editing',
      'street_view_display',
    ]);
    expect(
      parseExperiencePayload(experience, { requireAllowance: false }).fixtureCapabilities,
    ).toEqual([]);
    expect(() =>
      parseExperiencePayload(
        { ...experience, fixtureCapabilities: ['not_a_capability'] },
        { requireAllowance: false },
      ),
    ).toThrow();
  });

  it('reads the inline script tag and ignores malformed JSON', () => {
    document.body.innerHTML = `<script type="application/json" id="experience">${JSON.stringify(experience)}</script>`;
    expect(readInlineExperience()?.experience.defaultHolidayId).toBe('thanksgiving_us');
    document.body.innerHTML = '<script type="application/json" id="experience">{oops</script>';
    expect(readInlineExperience()).toBeNull();
  });

  it('ignores an allowance inlined in the shell, which predates the session', () => {
    const inline = { ...experience, allowance: allowance(6) };
    document.body.innerHTML = `<script type="application/json" id="experience">${JSON.stringify(inline)}</script>`;
    const snapshot = readInlineExperience();
    expect(snapshot?.experience.defaultHolidayId).toBe('thanksgiving_us');
    expect(snapshot?.allowance).toBeNull();
    expect(parseExperiencePayload(inline, { requireAllowance: true }).allowance).not.toBeNull();
  });
});

describe('fixture badge', () => {
  it('marks fixture integrations and non-Google Street View images', () => {
    expect(isFixtureImage('generated', ['image_editing'])).toBe(true);
    expect(isFixtureImage('generated', [])).toBe(false);
    expect(isFixtureImage('street_view', [], { url: '/v1/fixtures/sv/abc.jpg' })).toBe(true);
    expect(
      isFixtureImage('street_view', [], {
        url: 'https://maps.googleapis.com/maps/api/streetview?pano=x',
      }),
    ).toBe(false);
    expect(isFixtureImage('photo', [], { sourceKind: 'fixture' })).toBe(true);
    expect(isFixtureImage('photo', ['image_editing'])).toBe(false);
  });
});
