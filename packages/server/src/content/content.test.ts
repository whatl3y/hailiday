import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { HOLIDAY_IDS, SCENE_TYPES, packOfferFor, type HolidayPack } from '@hailiday/core';
import {
  ContentError,
  DEFAULT_CONTENT_DIR,
  heroRenditionSizes,
  lavishTextIssues,
  loadContent,
  occurrenceYears,
  packTextIssues,
  readPackByRef,
} from './index.js';

/** Runs `use` on a temporary copy of the content directory. */
async function withContentCopy(use: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hailiday-content-'));
  try {
    for (const entry of [
      'packs',
      'kits',
      'commerce',
      'heroes.json',
      'examples.json',
      'climate-classes.json',
    ]) {
      await cp(path.join(DEFAULT_CONTENT_DIR, entry), path.join(dir, entry), { recursive: true });
    }
    await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
      expect(pack.version).toBe('2.1.0');
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
    for (const kit of content.kits) expect(kit.packVersion).toBe('2.1.0');
    for (const example of content.examples) {
      expect(example.packVersion).toBe('2.1.0');
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

  it('gives every scene section of every pack a lavish description that asks for lights', async () => {
    const content = await loadContent();
    let sections = 0;
    for (const { holidayId, pack } of content.packs) {
      for (const sceneType of SCENE_TYPES) {
        const section = pack.sceneSections[sceneType];
        if (!section) continue;
        sections += 1;
        expect(section.promptFragments.lavish, `${holidayId}.${sceneType}`).toBeDefined();
        expect(section.promptFragments.lavish?.lit, `${holidayId}.${sceneType}`).toBe(true);
      }
    }
    expect(sections).toBe(15);
  });

  it('asks for electric lights in every lavish description of a scene that offers the evening look', async () => {
    const content = await loadContent();
    let evening = 0;
    for (const { holidayId, pack } of content.packs) {
      for (const sceneType of SCENE_TYPES) {
        if (!pack.lightingPolicy.bySceneType[sceneType]?.offered.includes('evening')) continue;
        evening += 1;
        const lavish = pack.sceneSections[sceneType]?.promptFragments.lavish;
        expect(lavish?.lit, `${holidayId}.${sceneType}`).toBe(true);
      }
    }
    expect(evening).toBe(8);
  });

  it('reports a lavish description that names a forbidden item or snow', async () => {
    const content = await loadContent();
    for (const { pack, contentRef } of content.packs) {
      expect(lavishTextIssues(pack, contentRef), contentRef).toEqual([]);
    }
    const christmas = content.packFor('christmas')?.pack as HolidayPack;
    const withText = (field: 'scene' | 'decorations' | 'negative', text: string): HolidayPack => {
      const copy = structuredClone(christmas);
      const lavish = copy.sceneSections.house_exterior?.promptFragments.lavish;
      if (!lavish) throw new Error('the Christmas house exterior has no lavish description');
      lavish[field] = `${lavish[field]} ${text}`;
      return copy;
    };
    const at = 'packs/christmas.yaml: sceneSections.house_exterior.promptFragments.lavish';
    expect(
      lavishTextIssues(withText('decorations', 'Add a Santa figure.'), 'packs/christmas.yaml'),
    ).toEqual([`${at}.decorations: names the forbidden item people`]);
    expect(
      lavishTextIssues(withText('decorations', 'Add an inflatable.'), 'packs/christmas.yaml'),
    ).toEqual([`${at}.decorations: names the forbidden item mascots_and_inflatables`]);
    expect(
      lavishTextIssues(withText('scene', 'with icicle lights'), 'packs/christmas.yaml'),
    ).toEqual([`${at}.scene: names snow, frost or icicles`]);
    // Line breaks of a folded text do not hide a word from the scan.
    expect(
      lavishTextIssues(withText('decorations', 'Hang\nfrosted\nwreaths.'), 'packs/christmas.yaml'),
    ).toEqual([`${at}.decorations: names snow, frost or icicles`]);
    // Nor do they split a pattern of two words, as a literal block keeps them.
    const literal = (
      parseYaml('text: |\n  Line the path with open\n  flames in tall lanterns.\n') as {
        text: string;
      }
    ).text;
    expect(literal).toContain('open\nflames');
    expect(lavishTextIssues(withText('decorations', literal), 'packs/christmas.yaml')).toEqual([
      `${at}.decorations: names the forbidden item open_flame_indoors`,
    ]);
    // The negative lists what must not appear and is not scanned.
    expect(
      lavishTextIssues(withText('negative', 'no Santa figure, no inflatable, no icicles'), 'x'),
    ).toEqual([]);
  });

  it('stops the load, and a read by reference, on a bad lavish description', async () => {
    await withContentCopy(async (dir) => {
      const file = path.join(dir, 'packs/christmas.yaml');
      const pack = parseYaml(await readFile(file, 'utf8')) as HolidayPack;
      const lavish = pack.sceneSections.house_exterior?.promptFragments.lavish;
      if (!lavish) throw new Error('the Christmas house exterior has no lavish description');
      lavish.decorations = `${lavish.decorations} An inflatable Santa waves from the roof.`;
      await writeFile(file, stringifyYaml(pack));
      await expect(loadContent({ dir })).rejects.toThrow(
        /lavish\.decorations: names the forbidden item/,
      );
      await expect(readPackByRef('packs/christmas.yaml', { dir })).rejects.toThrow(
        /lavish\.decorations: names the forbidden item/,
      );
    });
  });

  it('stops the load, and a read by reference, on a lavish description outside its limits', async () => {
    await withContentCopy(async (dir) => {
      const file = path.join(dir, 'packs/christmas.yaml');
      const original = await readFile(file, 'utf8');
      const at = 'packs/christmas.yaml: sceneSections.house_exterior.promptFragments.lavish';
      const cases: [string, (lavish: Record<string, unknown>) => void, string][] = [
        ['scene over 300', (l) => (l.scene = 'x'.repeat(301)), `${at}.scene: Too big`],
        [
          'decorations over 2000',
          (l) => (l.decorations = 'x'.repeat(2001)),
          `${at}.decorations: Too big`,
        ],
        [
          'decorations under 200',
          (l) => (l.decorations = 'x'.repeat(199)),
          `${at}.decorations: Too small`,
        ],
        ['negative over 600', (l) => (l.negative = 'x'.repeat(601)), `${at}.negative: Too big`],
        ['an unknown key', (l) => (l.extra = 'x'), `${at}: Unrecognized key: "extra"`],
        ['no lit', (l) => delete l.lit, `${at}.lit: Invalid input: expected boolean`],
        ['a lit that is not a boolean', (l) => (l.lit = 'yes'), `${at}.lit: Invalid input`],
        ['an empty scene', (l) => (l.scene = ''), `${at}.scene: Too small`],
      ];
      for (const [label, change, message] of cases) {
        const pack = parseYaml(original) as HolidayPack;
        const lavish = pack.sceneSections.house_exterior?.promptFragments.lavish;
        if (!lavish) throw new Error('the Christmas house exterior has no lavish description');
        change(lavish as unknown as Record<string, unknown>);
        await writeFile(file, stringifyYaml(pack));
        await expect(loadContent({ dir }), label).rejects.toThrow(message);
        await expect(readPackByRef('packs/christmas.yaml', { dir }), label).rejects.toThrow(
          message,
        );
      }
      // The same file within its limits loads.
      await writeFile(file, original);
      await expect(loadContent({ dir })).resolves.toBeDefined();
    });
  });

  it('reports a kit item or scene fragment that names a forbidden item of its pack', async () => {
    const content = await loadContent();
    for (const { pack, contentRef } of content.packs) {
      expect(packTextIssues(pack, contentRef), contentRef).toEqual([]);
    }
    const christmas = content.packFor('christmas')?.pack as HolidayPack;
    const section = (copy: HolidayPack) => {
      const exterior = copy.sceneSections.house_exterior;
      if (!exterior) throw new Error('the Christmas pack has no house exterior');
      return exterior;
    };
    const wreath = section(christmas).kit.findIndex((item) => item.kitItemId.includes('wreath'));
    expect(wreath).toBeGreaterThanOrEqual(0);
    const kitAt = `packs/christmas.yaml: sceneSections.house_exterior.kit.${wreath}.specText (${section(christmas).kit[wreath]?.kitItemId})`;
    const sceneAt = 'packs/christmas.yaml: sceneSections.house_exterior.promptFragments.scene';
    const withSpec = (specText: string) => {
      const copy = structuredClone(christmas);
      section(copy).kit[wreath] = { ...section(copy).kit[wreath]!, specText };
      return copy;
    };
    const withScene = (scene: string) => {
      const copy = structuredClone(christmas);
      section(copy).promptFragments.scene = scene;
      return copy;
    };
    expect(
      packTextIssues(withSpec('a wreath held by a smiling Santa figure'), 'packs/christmas.yaml'),
    ).toEqual([`${kitAt}: names the forbidden item people`]);
    expect(
      packTextIssues(withScene('a display with a nativity scene'), 'packs/christmas.yaml'),
    ).toEqual([`${sceneAt}: names the forbidden item religious_symbols`]);
    // A pattern of two words across a line break is found.
    expect(
      packTextIssues(withSpec('a wreath beside two real\ncandles'), 'packs/christmas.yaml'),
    ).toEqual([`${kitAt}: names the forbidden item open_flame_indoors`]);
    // A kit item that names snow is left out of a plan for a photo without snow, not refused.
    expect(packTextIssues(withSpec('a snow-dusted evergreen wreath'), 'x')).toEqual([]);
    expect(packTextIssues(withScene('a frosted winter display'), 'x')).toEqual([]);
    // The lavish texts are not part of this scan.
    const lavish = structuredClone(christmas);
    const fragment = section(lavish).promptFragments.lavish;
    if (!fragment) throw new Error('the Christmas house exterior has no lavish description');
    fragment.decorations = `${fragment.decorations} Add a Santa figure.`;
    expect(packTextIssues(lavish, 'x')).toEqual([]);
  });

  it('stops the load, and a read by reference, on a kit item or scene fragment that names a forbidden item', async () => {
    await withContentCopy(async (dir) => {
      // A skeleton spec text that names blood, in the pack and in its kit mirror.
      const reworded = 'clean and undamaged';
      const before = 'clean with no blood or damage';
      for (const relative of ['packs/halloween.yaml', 'kits/halloween.yaml']) {
        const file = path.join(dir, relative);
        const text = await readFile(file, 'utf8');
        expect(text.split(reworded).length, relative).toBe(2);
        await writeFile(file, text.replace(reworded, before));
      }
      const skeleton =
        'packs/halloween.yaml: sceneSections.house_exterior.kit.5.specText (halloween.house_exterior.skeleton_stylized): names the forbidden item gore';
      const loaded = await loadContent({ dir }).catch((error: unknown) => error);
      expect(loaded).toBeInstanceOf(ContentError);
      expect((loaded as ContentError).issues).toEqual([skeleton]);
      const read = await readPackByRef('packs/halloween.yaml', { dir }).catch((e: unknown) => e);
      expect(read).toBeInstanceOf(ContentError);
      expect((read as ContentError).issues).toEqual([skeleton]);
      for (const relative of ['packs/halloween.yaml', 'kits/halloween.yaml']) {
        await cp(path.join(DEFAULT_CONTENT_DIR, relative), path.join(dir, relative));
      }
      await expect(loadContent({ dir })).resolves.toBeDefined();

      const file = path.join(dir, 'packs/christmas.yaml');
      const pack = parseYaml(await readFile(file, 'utf8')) as HolidayPack;
      const exterior = pack.sceneSections.house_exterior;
      if (!exterior) throw new Error('the Christmas pack has no house exterior');
      exterior.promptFragments.scene = `${exterior.promptFragments.scene} with a nativity scene`;
      await writeFile(file, stringifyYaml(pack));
      const scene =
        'packs/christmas.yaml: sceneSections.house_exterior.promptFragments.scene: names the forbidden item religious_symbols';
      const sceneLoad = await loadContent({ dir }).catch((error: unknown) => error);
      expect((sceneLoad as ContentError).issues).toEqual([scene]);
      const sceneRead = await readPackByRef('packs/christmas.yaml', { dir }).catch(
        (e: unknown) => e,
      );
      expect((sceneRead as ContentError).issues).toEqual([scene]);
    });
  });

  it('computes rendition sizes and occurrence years', () => {
    expect(heroRenditionSizes({ aspect: '3:2', renditionWidths: [1200] })).toEqual([
      { width: 1200, height: 800 },
    ]);
    expect(occurrenceYears(new Date('2027-01-01T03:00:00Z'))).toEqual([2025, 2026, 2027]);
  });
});
