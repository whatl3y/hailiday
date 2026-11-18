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
  isSearchPhrase,
  isSearchUrlTemplate,
  isTrackingLinkTemplate,
  lavishTextIssues,
  loadContent,
  lookItemIssues,
  occurrenceYears,
  packTextIssues,
  readPackByRef,
  searchPhraseIssues,
} from './index.js';
import type { LookItemContent, PackContent, SearchPhraseContent } from './index.js';

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

  it('reads the program records, a search phrase per kit item and the look items of the lavish looks', async () => {
    const content = await loadContent();
    const { catalog, programExtras, searchPhrases, lookItems } = content.commerce;
    const kindOf = (key: string) => programExtras.get(key)?.kind;
    const real = catalog.merchantPrograms.filter((p) => kindOf(p.programKey) === 'real');
    expect(real.map((p) => p.programKey).sort()).toEqual([
      'amazon_us',
      'home_depot_us',
      'lowes_us',
      'target_us',
      'walmart_us',
    ]);
    for (const program of real) {
      const extras = programExtras.get(program.programKey);
      expect(program.status, program.programKey).toBe('planned');
      expect(extras?.searchUrlTemplate, program.programKey).toMatch(/^https:\/\/www\./);
      expect(extras?.displayRights, program.programKey).toEqual({});
      expect(extras?.placement, program.programKey).toBe(
        program.programKey === 'amazon_us' ? 'separate' : 'group',
      );
    }
    for (const program of catalog.merchantPrograms) {
      expect(kindOf(program.programKey), program.programKey).toMatch(/^(fixture|real)$/);
    }
    expect(programExtras.get('fixture_marketplace_us')).toMatchObject({
      kind: 'fixture',
      placement: 'separate',
      trackingLinkTemplate: '{destinationUrl}&tag={trackingId}',
      refreshTermHours: null,
    });

    const kitItemKeys = content.kits.flatMap(({ kit }) => kit.items.map((item) => item.kitItemId));
    expect(searchPhrases.map((phrase) => phrase.kitItemKey).sort()).toEqual(kitItemKeys.sort());
    expect(lookItems.length).toBeGreaterThan(0);
    for (const item of lookItems) {
      expect(item.lookItemKey).toMatch(/^[a-z_]+\.house_exterior\.abundant\./);
      expect(item.programOverrides).toEqual({});
    }
    expect(lookItems.some((item) => item.anchorCategory === null)).toBe(true);
  });

  it('accepts only the search and tracking link patterns the database accepts', () => {
    expect(isSearchUrlTemplate('https://www.example.com/s?k={query}')).toBe(true);
    expect(isSearchUrlTemplate('https://www.example.com/s/{query}')).toBe(true);
    expect(isSearchUrlTemplate('http://www.example.com/s?k={query}')).toBe(false);
    expect(isSearchUrlTemplate('https://www.example.com/search')).toBe(false);
    expect(isSearchUrlTemplate('{query}')).toBe(false);
    expect(isSearchUrlTemplate('https://www.example.com:8443/s/{query}')).toBe(true);
    // An affiliate parameter, a placeholder in the host, no slash after the host, and a tracking
    // placeholder are refused.
    expect(isSearchUrlTemplate('https://www.example.com/s?k={query}&tag=hailiday-20')).toBe(false);
    expect(isSearchUrlTemplate('https://www.example.com/s?SubId=1&k={query}')).toBe(false);
    expect(isSearchUrlTemplate('https://www.example.com/s?k={query}&u1=a')).toBe(false);
    expect(isSearchUrlTemplate('https://{query}.example.com/search')).toBe(false);
    expect(isSearchUrlTemplate('https://www.example.com?q={query}')).toBe(false);
    expect(isSearchUrlTemplate('https://www.example.com/s?k={query}&sub={subId}')).toBe(false);
    expect(isSearchUrlTemplate('https://www.example.com/s?k={query}&t={trackingId}')).toBe(false);
    expect(isSearchUrlTemplate('https://www.example.com/s?k={query}&u={destinationUrl}')).toBe(
      false,
    );
    expect(isTrackingLinkTemplate('https://network.example/c?url={destinationUrl}')).toBe(true);
    expect(isTrackingLinkTemplate('{destinationUrl}&tag={trackingId}')).toBe(true);
    expect(isTrackingLinkTemplate('http://network.example/c?url={destinationUrl}')).toBe(false);
    expect(isTrackingLinkTemplate('tag={trackingId}&{destinationUrl}')).toBe(false);
    // Without `{destinationUrl}`, with a placeholder in the host, or no slash after the host.
    expect(isTrackingLinkTemplate('https://network.example/c?sub={subId}')).toBe(false);
    expect(
      isTrackingLinkTemplate('https://{trackingId}.network.example/c?u={destinationUrl}'),
    ).toBe(false);
    expect(isTrackingLinkTemplate('https://network.example?u={destinationUrl}')).toBe(false);
  });

  it('accepts only plain words as a search phrase', () => {
    expect(isSearchPhrase('30 inch pre-lit wreath')).toBe(true);
    expect(isSearchPhrase("shepherd's hook lantern")).toBe(true);
    expect(isSearchPhrase('x')).toBe(false);
    expect(isSearchPhrase('a'.repeat(121))).toBe(false);
    expect(isSearchPhrase('lights/garland')).toBe(false);
    expect(isSearchPhrase('lights...')).toBe(false);
    expect(isSearchPhrase(' leading space')).toBe(false);
  });

  it('reports a search phrase for no kit item, twice for one, or missing for one', async () => {
    const content = await loadContent();
    const programKeys = new Set(content.commerce.catalog.merchantPrograms.map((p) => p.programKey));
    const phrases = content.commerce.searchPhrases;
    expect(searchPhraseIssues(phrases, content.kits, programKeys)).toEqual([]);
    const [first, second, ...rest] = phrases as [
      SearchPhraseContent,
      SearchPhraseContent,
      ...SearchPhraseContent[],
    ];
    const changed: SearchPhraseContent[] = [
      first,
      { ...first, phrase: 'another phrase' },
      {
        kitItemKey: 'christmas.house_exterior.not_a_kit_item',
        phrase: 'lights',
        programOverrides: {},
      },
      { ...rest[0]!, programOverrides: { walmart_us: 'walmart words', nowhere_us: 'other words' } },
      ...rest.slice(1),
    ];
    expect(searchPhraseIssues(changed, content.kits, programKeys)).toEqual([
      `search-phrases.json: ${first.kitItemKey} appears twice`,
      'search-phrases.json: christmas.house_exterior.not_a_kit_item is not a kit item key',
      `search-phrases.json: ${rest[0]!.kitItemKey}: programOverrides names unknown program nowhere_us`,
      `search-phrases.json: kit item ${second.kitItemKey} has no search phrase`,
    ]);
  });

  it('reports a look item outside its look, without a lavish description or out of order', async () => {
    const content = await loadContent();
    const programKeys = new Set(content.commerce.catalog.merchantPrograms.map((p) => p.programKey));
    const items = content.commerce.lookItems;
    expect(lookItemIssues(items, content.packs, programKeys)).toEqual([]);
    const christmas = items.filter((item) => item.holidayId === 'christmas');
    const [first, second] = christmas as [LookItemContent, LookItemContent];
    const look = 'christmas.house_exterior.abundant';
    const at = (key: string) => `look-items.json: ${key}`;
    const halloween = items.find((item) => item.holidayId === 'halloween')!;
    const changed: LookItemContent[] = [
      first,
      // The same key twice.
      { ...first, sortOrder: 90 },
      // A key outside its look.
      { ...second, lookItemKey: 'christmas.house_exterior.classic.porch_lights', sortOrder: 91 },
      // The sort order of another item of the same look.
      { ...second, lookItemKey: `${look}.second_at_first`, sortOrder: first.sortOrder },
      // The same sort order in another look is fine.
      { ...halloween, sortOrder: first.sortOrder },
      // A style the pack does not offer for the scene, and a scene the pack has no section for.
      {
        ...first,
        lookItemKey: 'new_years_eve.apartment_entry.abundant.gold_garland',
        holidayId: 'new_years_eve',
        sceneType: 'apartment_entry',
        sortOrder: 1,
      },
      {
        ...first,
        lookItemKey: `${look}.overrides`,
        sortOrder: 92,
        programOverrides: { nowhere_us: 'x y' },
      },
    ];
    expect(lookItemIssues(changed, content.packs, programKeys)).toEqual([
      `${at(first.lookItemKey)}: appears twice`,
      `${at('christmas.house_exterior.classic.porch_lights')}: the key must start with ${look}.`,
      `${at(`${look}.second_at_first`)}: sortOrder ${first.sortOrder} is used twice in the look ${look}`,
      `${at('new_years_eve.apartment_entry.abundant.gold_garland')}: pack new_years_eve.US has no apartment_entry section`,
      `${at(`${look}.overrides`)}: programOverrides names unknown program nowhere_us`,
    ]);

    // A pack section without a lavish description, and a holiday with no pack.
    const withoutLavish = content.packs.map((entry): PackContent => {
      if (entry.holidayId !== 'christmas') return entry;
      const pack = structuredClone(entry.pack);
      delete pack.sceneSections.house_exterior?.promptFragments.lavish;
      return { ...entry, pack };
    });
    expect(lookItemIssues([first], withoutLavish, programKeys)).toEqual([
      `${at(first.lookItemKey)}: pack christmas.US has no lavish description for house_exterior`,
    ]);
    const noChristmas = content.packs.filter((entry) => entry.holidayId !== 'christmas');
    expect(lookItemIssues([first], noChristmas, programKeys)).toEqual([
      `${at(first.lookItemKey)}: no pack for christmas`,
    ]);
  });

  it('stops the load on a program record, search phrase or look item outside its schema', async () => {
    await withContentCopy(async (dir) => {
      const read = async (relative: string) =>
        JSON.parse(await readFile(path.join(dir, relative), 'utf8')) as Record<string, unknown>;
      const write = (relative: string, value: unknown) =>
        writeFile(path.join(dir, relative), JSON.stringify(value, null, 2));
      const issuesOf = async () => {
        const loaded = await loadContent({ dir }).catch((error: unknown) => error);
        expect(loaded).toBeInstanceOf(ContentError);
        return (loaded as ContentError).issues;
      };

      const programsFile = 'commerce/merchant-programs.json';
      const programs = await read(programsFile);
      const records = programs.programs as Record<string, unknown>[];
      const byKey = (key: string) => records.find((record) => record.merchantProgramId === key)!;
      const original = structuredClone(programs);
      delete byKey('walmart_us').kind;
      byKey('target_us').searchUrlTemplate = 'https://www.target.com/s';
      byKey('home_depot_us').trackingLinkTemplate = 'http://www.homedepot.com/?u={destinationUrl}';
      byKey('lowes_us').displayRights = {
        tracked_search_links: { state: 'allowed', evidence: null, recordedAt: null },
      };
      byKey('amazon_us').refreshTermHours = 0;
      byKey('fixture_decor_us').placement = 'inline';
      byKey('fixture_harvest_market_us').displayRights = {
        logo: { state: 'unknown', evidence: null, recordedAt: null },
      };
      byKey('fixture_home_garden_us').searchUrlTemplate =
        'https://example.com/fixture-home-garden/search?q={query}&tag=hailiday-20';
      byKey('fixture_marketplace_us').searchUrlTemplate = 'https://{query}.example.com/search';
      byKey('fixture_holiday_outlet_us').searchUrlTemplate = 'https://example.com?q={query}';
      byKey('fixture_lights_lanterns_us').trackingLinkTemplate =
        'https://example.com/fixture-network/click/fll?subId1={subId}';
      await write(programsFile, programs);
      const programIssues = await issuesOf();
      for (const [key, field] of [
        ['walmart_us', 'kind'],
        ['target_us', 'searchUrlTemplate'],
        ['home_depot_us', 'trackingLinkTemplate'],
        ['lowes_us', 'displayRights.tracked_search_links.evidence'],
        ['amazon_us', 'refreshTermHours'],
        ['fixture_decor_us', 'placement'],
        ['fixture_harvest_market_us', 'displayRights'],
        ['fixture_home_garden_us', 'searchUrlTemplate'],
        ['fixture_marketplace_us', 'searchUrlTemplate'],
        ['fixture_holiday_outlet_us', 'searchUrlTemplate'],
        ['fixture_lights_lanterns_us', 'trackingLinkTemplate'],
      ]) {
        expect(
          programIssues.some((issue) =>
            issue.startsWith(`merchant-programs.json ${key}: ${field}`),
          ),
          `${key} ${field}: ${programIssues.join('\n')}`,
        ).toBe(true);
      }
      expect(programIssues).toHaveLength(11);
      await write(programsFile, original);
      await expect(loadContent({ dir })).resolves.toBeDefined();

      const phrasesFile = 'commerce/search-phrases.json';
      const phrases = await read(phrasesFile);
      const entries = phrases.phrases as Record<string, unknown>[];
      const keyOf = (index: number) => String(entries[index]?.kitItemKey);
      entries[0]!.phrase = 'x';
      entries[1]!.phrase = 'y'.repeat(121);
      entries[2]!.extra = true;
      entries[3]!.phrase = 'lights/garland';
      entries[4]!.phrase = 'pre.lit wreath';
      entries[5]!.programOverrides = { walmart_us: 'net lights...' };
      await write(phrasesFile, phrases);
      expect(await issuesOf()).toEqual([
        expect.stringMatching(/^search-phrases\.json: phrases\.0\.phrase: /),
        expect.stringMatching(/^search-phrases\.json: phrases\.1\.phrase: /),
        expect.stringMatching(/^search-phrases\.json: phrases\.2: Unrecognized key/),
        expect.stringMatching(/^search-phrases\.json: phrases\.3\.phrase: /),
        expect.stringMatching(/^search-phrases\.json: phrases\.4\.phrase: /),
        expect.stringMatching(/^search-phrases\.json: phrases\.5\.programOverrides\.walmart_us: /),
      ]);
      expect(keyOf(0)).toMatch(/^christmas\./);
      await rm(path.join(dir, phrasesFile));
      expect(await issuesOf()).toEqual([
        expect.stringMatching(/^commerce\/search-phrases\.json: .*ENOENT/),
      ]);
      await cp(path.join(DEFAULT_CONTENT_DIR, phrasesFile), path.join(dir, phrasesFile));

      const lookFile = 'commerce/look-items.json';
      const looks = await read(lookFile);
      const lookItems = looks.lookItems as Record<string, unknown>[];
      lookItems[0]!.anchorCategory = 'chimney_top';
      lookItems[1]!.style = 'lavish';
      lookItems[2]!.lookItemKey = 'Christmas.Upper';
      lookItems[3]!.ourTitle = 'x';
      lookItems[4]!.holidayId = 'easter';
      lookItems[5]!.searchPhrase = 'net/curtain lights';
      await write(lookFile, looks);
      expect(await issuesOf()).toEqual([
        expect.stringMatching(/^look-items\.json: lookItems\.0\.anchorCategory: /),
        expect.stringMatching(/^look-items\.json: lookItems\.1\.style: /),
        expect.stringMatching(/^look-items\.json: lookItems\.2\.lookItemKey: /),
        expect.stringMatching(/^look-items\.json: lookItems\.3\.ourTitle: /),
        expect.stringMatching(/^look-items\.json: lookItems\.4\.holidayId: /),
        expect.stringMatching(/^look-items\.json: lookItems\.5\.searchPhrase: /),
      ]);
      await cp(path.join(DEFAULT_CONTENT_DIR, lookFile), path.join(dir, lookFile));
      await expect(loadContent({ dir })).resolves.toBeDefined();
    });
  });

  it('computes rendition sizes and occurrence years', () => {
    expect(heroRenditionSizes({ aspect: '3:2', renditionWidths: [1200] })).toEqual([
      { width: 1200, height: 800 },
    ]);
    expect(occurrenceYears(new Date('2027-01-01T03:00:00Z'))).toEqual([2025, 2026, 2027]);
  });
});
