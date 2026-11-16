import { describe, expect, it } from 'vitest';
import { HOLIDAY_IDS, SCENE_TYPES, packOfferFor } from '@hailiday/core';
import { heroRenditionSizes, loadContent, occurrenceYears, readPackByRef } from './index.js';

describe('loadContent', () => {
  it('validates packs, kits, commerce, heroes and examples from the repository', async () => {
    const content = await loadContent();
    expect(content.packs.map((pack) => pack.holidayId).sort()).toEqual([...HOLIDAY_IDS].sort());
    for (const pack of content.packs) {
      expect(pack.majorMinor).toBe(pack.version.split('.').slice(0, 2).join('.'));
      expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pack.contentRef).toBe(`packs/${pack.holidayId}.yaml`);
    }
    expect(content.kitFor('christmas', 'house_exterior')?.kit.items.length).toBeGreaterThan(3);
    expect(content.kitFor('new_years_eve', 'apartment_entry')).toBeUndefined();
    expect(content.commerce.catalog.offers.length).toBeGreaterThan(0);
    expect(content.commerce.rebaseTimestampsOnSeed).toBe(true);
    expect(content.heroes.some((hero) => hero.holidayId === null)).toBe(true);
    expect(content.climateClasses.VT).toBe('cold');
    for (const { kit } of content.kits) {
      for (const item of kit.items)
        expect(item.specAttributes.colorFamily.length).toBeGreaterThan(0);
    }
  });

  it('offers abundant first everywhere, evening first outdoors and only the bright look inside', async () => {
    const content = await loadContent();
    const offers: Record<string, unknown> = {};
    for (const pack of content.packs) {
      expect(pack.version).toBe('2.0.0');
      for (const sceneType of SCENE_TYPES) {
        const offer = packOfferFor(pack.pack, sceneType);
        if (offer) offers[`${pack.holidayId}.${sceneType}`] = offer;
      }
    }
    const styles = ['subtle', 'classic', 'abundant'];
    const outdoors = {
      styles,
      defaultStyle: 'abundant',
      lightingModes: ['source', 'evening'],
      defaultLightingMode: 'evening',
    };
    const bright = {
      styles,
      defaultStyle: 'abundant',
      lightingModes: ['bright'],
      defaultLightingMode: 'bright',
    };
    expect(offers).toEqual({
      'christmas.house_exterior': outdoors,
      'christmas.apartment_entry': bright,
      'christmas.balcony': outdoors,
      'christmas.interior': bright,
      'halloween.house_exterior': outdoors,
      'halloween.apartment_entry': bright,
      'halloween.balcony': outdoors,
      'halloween.interior': bright,
      'new_years_eve.house_exterior': outdoors,
      'new_years_eve.balcony': outdoors,
      'new_years_eve.interior': bright,
      'thanksgiving_us.house_exterior': outdoors,
      'thanksgiving_us.apartment_entry': bright,
      'thanksgiving_us.balcony': outdoors,
      'thanksgiving_us.interior': bright,
    });
    for (const pack of content.packs) {
      expect(pack.pack.lightingPolicy.eveningGuidance).toBeTruthy();
      expect(pack.pack.lightingPolicy.eveningGuidance).not.toMatch(/interiors only/i);
    }
    for (const kit of content.kits) expect(kit.packVersion).toBe('2.0.0');
    for (const example of content.examples) {
      expect(example.packVersion).toBe('2.0.0');
      if (example.lightingMode === 'evening') expect(example.sceneType).toBe('house_exterior');
      const indoors = example.sceneType === 'interior' || example.sceneType === 'apartment_entry';
      expect(example.lightingMode === 'bright').toBe(indoors);
      expect(example.exampleId).toContain(`.${example.lightingMode}.`);
    }
  });

  it('reads a pack by content reference and checks its checksum', async () => {
    const content = await loadContent();
    const christmas = content.packFor('christmas');
    expect(christmas).toBeDefined();
    const pack = await readPackByRef(christmas!.contentRef, { expectedSha256: christmas!.sha256 });
    expect(pack.id).toBe('christmas.US');
    await expect(
      readPackByRef(christmas!.contentRef, { expectedSha256: '0'.repeat(64) }),
    ).rejects.toThrow(/changed/);
    await expect(readPackByRef('../secrets.yaml')).rejects.toThrow(/content_ref/);
  });

  it('computes rendition sizes and occurrence years', () => {
    expect(heroRenditionSizes({ aspect: '3:2', renditionWidths: [1200] })).toEqual([
      { width: 1200, height: 800 },
    ]);
    expect(occurrenceYears(new Date('2027-01-01T03:00:00Z'))).toEqual([2025, 2026, 2027]);
  });
});
