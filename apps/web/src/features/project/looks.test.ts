import { describe, expect, it } from 'vitest';
import type { ExperienceHoliday } from '@hailiday/core';
import { SOURCE_ASSET_ID, allowance, plainSpaces, variant } from '../../test/fixtures';
import {
  allowanceCounterText,
  asPhotographedStandIn,
  defaultLook,
  findCachedVariant,
  holidaysForScene,
  lookLabel,
  looksExhausted,
  normalizeLook,
  offeredForHoliday,
  shareAvailability,
  variantsOfSource,
  withVariant,
} from './looks';

function holiday(overrides: Partial<ExperienceHoliday>): ExperienceHoliday {
  return {
    id: 'halloween',
    nameKey: 'holiday.halloween',
    isDefault: false,
    journeyEmphasis: 'exterior',
    inWindow: false,
    windowStart: null,
    windowEnd: null,
    packVersion: '1.0.0',
    sceneTypes: {},
    ...overrides,
  };
}

describe('allowance counter', () => {
  it('reads "{n} more looks today" while looks remain, in the singular for the last one', () => {
    expect(allowanceCounterText(allowance(4))).toBe('4 more looks today');
    expect(allowanceCounterText(allowance(2))).toBe('2 more looks today');
    expect(allowanceCounterText(allowance(1))).toBe('1 more look today');
  });

  it('names the reset time at zero', () => {
    const text = allowanceCounterText(allowance(0));
    expect(text.startsWith('No more looks today · more at ')).toBe(true);
    expect(text).not.toContain('{resetsAt}');
  });

  it('says the allowance is exhausted only at zero', () => {
    expect(looksExhausted(allowance(0))).toBe(true);
    expect(looksExhausted(allowance(2))).toBe(false);
    expect(looksExhausted(null)).toBe(false);
  });
});

describe('cached looks', () => {
  it('finds the newest variant for a combination', () => {
    const older = variant({ createdAt: '2026-11-09T10:00:00.000Z' });
    const newer = variant({ createdAt: '2026-11-09T11:00:00.000Z' });
    const evening = variant({ lightingMode: 'evening' });
    const list = [older, evening, newer];
    expect(
      findCachedVariant(
        list,
        { holidayId: 'christmas', style: 'classic', lightingMode: 'source' },
        SOURCE_ASSET_ID,
      ),
    ).toBe(newer);
    expect(
      findCachedVariant(
        list,
        { holidayId: 'halloween', style: 'classic', lightingMode: 'source' },
        SOURCE_ASSET_ID,
      ),
    ).toBeNull();
  });

  it('never matches a variant of another source', () => {
    const replaced = variant({ sourceAssetId: '018f0000-0000-7000-8000-cccccccccccc' });
    const look = { holidayId: 'christmas', style: 'classic', lightingMode: 'source' } as const;
    expect(findCachedVariant([replaced], look, SOURCE_ASSET_ID)).toBeNull();
    expect(findCachedVariant([replaced], look, replaced.sourceAssetId)).toBe(replaced);
    expect(findCachedVariant([replaced], look, null)).toBeNull();
    expect(variantsOfSource([replaced], SOURCE_ASSET_ID)).toEqual([]);
  });

  it('offers only holidays with a section for the scene type', () => {
    const holidays = [
      holiday({ id: 'halloween', sceneTypes: {} }),
      holiday({
        id: 'christmas',
        sceneTypes: {
          balcony: {
            styles: ['classic'],
            defaultStyle: 'classic',
            lightingModes: ['source'],
            defaultLightingMode: 'source',
          },
        } as ExperienceHoliday['sceneTypes'],
      }),
    ];
    expect(holidaysForScene(['halloween', 'christmas'], holidays, 'balcony')).toEqual([
      'christmas',
    ]);
    expect(holidaysForScene(['halloween', 'christmas'], holidays, null)).toEqual([
      'halloween',
      'christmas',
    ]);
  });

  it('adds a variant once, newest first', () => {
    const a = variant({ createdAt: '2026-11-09T10:00:00.000Z' });
    const b = variant({ createdAt: '2026-11-09T12:00:00.000Z' });
    expect(withVariant(withVariant([a], b), b).map((item) => item.renderAssetId)).toEqual([
      b.renderAssetId,
      a.renderAssetId,
    ]);
  });
});

describe('offered looks', () => {
  const holidays = [
    holiday({
      id: 'halloween',
      sceneTypes: {
        house_exterior: {
          styles: ['classic', 'abundant'],
          defaultStyle: 'abundant',
          lightingModes: ['source', 'evening'],
          defaultLightingMode: 'source',
        },
      },
    }),
  ];

  it("uses the project's own offered set for its current holiday", () => {
    const offered = offeredForHoliday({
      holidayId: 'christmas',
      projectHolidayId: 'christmas',
      projectOffered: {
        styles: ['subtle', 'classic'],
        defaultStyle: 'classic',
        lightingModes: ['source'],
        defaultLightingMode: 'source',
      },
      sceneType: 'house_exterior',
      holidays,
    });
    expect(offered.styles).toEqual(['subtle', 'classic']);
    expect(offered.lightingModes).toEqual(['source']);
  });

  it("starts the project's own holiday from the server's default look, evening included", () => {
    const offered = offeredForHoliday({
      holidayId: 'christmas',
      projectHolidayId: 'christmas',
      projectOffered: {
        styles: ['subtle', 'classic', 'abundant'],
        defaultStyle: 'abundant',
        lightingModes: ['source', 'evening'],
        defaultLightingMode: 'evening',
      },
      sceneType: 'house_exterior',
      holidays,
    });
    expect(offered.defaultStyle).toBe('abundant');
    expect(offered.defaultLightingMode).toBe('evening');
    expect(defaultLook('christmas', offered)).toEqual({
      holidayId: 'christmas',
      style: 'abundant',
      lightingMode: 'evening',
    });
  });

  it("limits another holiday's lighting to what the source allows", () => {
    const offered = offeredForHoliday({
      holidayId: 'halloween',
      projectHolidayId: 'christmas',
      projectOffered: {
        styles: ['classic'],
        defaultStyle: 'classic',
        lightingModes: ['source'],
        defaultLightingMode: 'source',
      },
      sceneType: 'house_exterior',
      holidays,
    });
    expect(offered.styles).toEqual(['classic', 'abundant']);
    expect(offered.lightingModes).toEqual(['source']);
    expect(
      normalizeLook({ holidayId: 'halloween', style: 'subtle', lightingMode: 'evening' }, offered),
    ).toEqual({ holidayId: 'halloween', style: 'abundant', lightingMode: 'source' });
  });
});

describe('look labels', () => {
  it('names the lighting where the scene offers a choice of lighting', () => {
    expect(
      plainSpaces(
        lookLabel({ holidayId: 'christmas', style: 'abundant', lightingMode: 'evening' }, [
          'source',
          'evening',
        ]),
      ),
    ).toBe('Christmas · Abundant · Evening');
  });

  it('leaves the lighting out where the scene offers a single lighting mode', () => {
    expect(
      plainSpaces(
        lookLabel({ holidayId: 'christmas', style: 'abundant', lightingMode: 'source' }, [
          'source',
        ]),
      ),
    ).toBe('Christmas · Abundant');
    // A look made before the scene lost evening still says it was an evening look.
    expect(
      plainSpaces(
        lookLabel({ holidayId: 'christmas', style: 'abundant', lightingMode: 'evening' }, [
          'source',
        ]),
      ),
    ).toBe('Christmas · Abundant · Evening');
  });

  it('wraps only after a separator, never inside a part or before a separator', () => {
    const label = lookLabel(
      { holidayId: 'new_years_eve', style: 'abundant', lightingMode: 'source' },
      ['source', 'evening'],
    );
    expect(label).toBe("New\u00a0Year's\u00a0Eve\u00a0· Abundant\u00a0· As\u00a0photographed");
    // The only break opportunities are the plain spaces after each separator.
    expect(label.split(' ')).toEqual([
      "New\u00a0Year's\u00a0Eve\u00a0·",
      'Abundant\u00a0·',
      'As\u00a0photographed',
    ]);
  });
});

describe('bright looks', () => {
  it('never names the lighting of a bright look, even beside other modes', () => {
    expect(
      plainSpaces(
        lookLabel({ holidayId: 'christmas', style: 'abundant', lightingMode: 'bright' }, [
          'bright',
        ]),
      ),
    ).toBe('Christmas · Abundant');
    expect(
      plainSpaces(
        lookLabel({ holidayId: 'christmas', style: 'abundant', lightingMode: 'bright' }, [
          'source',
          'evening',
          'bright',
        ]),
      ),
    ).toBe('Christmas · Abundant');
  });

  it('starts an interior from its only lighting, bright', () => {
    const offered = offeredForHoliday({
      holidayId: 'halloween',
      projectHolidayId: 'christmas',
      projectOffered: {
        styles: ['subtle', 'classic', 'abundant'],
        defaultStyle: 'abundant',
        lightingModes: ['bright'],
        defaultLightingMode: 'bright',
      },
      sceneType: 'interior',
      holidays: [
        holiday({
          id: 'halloween',
          sceneTypes: {
            interior: {
              styles: ['subtle', 'classic', 'abundant'],
              defaultStyle: 'abundant',
              lightingModes: ['bright'],
              defaultLightingMode: 'bright',
            },
          },
        }),
      ],
    });
    expect(offered.lightingModes).toEqual(['bright']);
    expect(defaultLook('halloween', offered)).toEqual({
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'bright',
    });
    // A look remembered from before interiors were brightened moves to bright.
    expect(
      normalizeLook({ holidayId: 'halloween', style: 'classic', lightingMode: 'source' }, offered),
    ).toEqual({ holidayId: 'halloween', style: 'classic', lightingMode: 'bright' });
  });
});

describe('a dusk or night photo', () => {
  const duskEvening = variant({ style: 'abundant', lightingMode: 'evening' });
  const look = { holidayId: 'christmas', style: 'abundant', lightingMode: 'source' } as const;

  it('lets its evening variant stand in for the look as photographed once evening is gone', () => {
    expect(asPhotographedStandIn([duskEvening], look, SOURCE_ASSET_ID, ['source'])).toBe(
      duskEvening,
    );
  });

  it('keeps an evening variant apart while evening is offered, or for another look', () => {
    expect(
      asPhotographedStandIn([duskEvening], look, SOURCE_ASSET_ID, ['source', 'evening']),
    ).toBeNull();
    expect(
      asPhotographedStandIn([duskEvening], { ...look, style: 'subtle' }, SOURCE_ASSET_ID, [
        'source',
      ]),
    ).toBeNull();
    expect(
      asPhotographedStandIn([duskEvening], { ...look, lightingMode: 'bright' }, SOURCE_ASSET_ID, [
        'bright',
      ]),
    ).toBeNull();
    expect(
      asPhotographedStandIn([duskEvening], look, '018f0000-0000-7000-8000-cccccccccccc', [
        'source',
      ]),
    ).toBeNull();
  });
});

describe('share availability', () => {
  it('has no Share for private-only previews', () => {
    expect(shareAvailability(variant({ privateOnly: true }), true)).toEqual({
      canShare: false,
      unavailableNote: false,
    });
  });

  it('explains under More when a street photo cannot be shared', () => {
    const streetView = variant({
      distributable: false,
      attribution: { required: true, text: '© Google', logo: 'google_maps' },
    });
    expect(shareAvailability(streetView, true)).toEqual({
      canShare: false,
      unavailableNote: true,
    });
    expect(shareAvailability(variant(), true).canShare).toBe(true);
  });
});
