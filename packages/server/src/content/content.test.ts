import { describe, expect, it } from 'vitest';
import { HOLIDAY_IDS } from '@holiday/core';
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
