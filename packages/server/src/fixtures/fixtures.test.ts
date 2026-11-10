import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { NormalizedBoxSchema, type DecorationPlan } from '@holiday/core';
import { testConfig } from '../config/index.js';
import { loadContent, type Content } from '../content/load.js';
import { sha256Hex } from '../ids/index.js';
import { createProviders } from '../providers/create.js';
import { archetypeFor } from './archetypes.js';
import { renderGenericScene } from './art.js';
import { decorateImage } from './compositor.js';
import {
  loadFixtureData,
  renderScenarioForFileName,
  renderScenarioForPlace,
  sceneHintForFileName,
} from './data.js';
import { genericUploadGeometry } from './layouts.js';
import { fixturePlacements } from './plan.js';
import type { FixtureSceneGeometry } from './scene.js';
import {
  HERO_ASPECT,
  encodeHeroRendition,
  extractHeroCrop,
  heroCropRect,
  type HeroOrientation,
} from './heroes.js';
import { renderHouse, streetViewCamera } from './house.js';
import { loadPhotoLibrary, panoramaCrop, transformBox, type HousePhoto } from './photos.js';
import {
  fixturePanoramaFrame,
  fixturePanoramaGeometry,
  referenceView,
  renderFixturePanorama,
} from './street-view.js';
import { rasterize } from './svg.js';

let content: Content;
beforeAll(async () => {
  content = await loadContent();
});

const lanternView = { panoId: 'fxSvLanternHillC01p1Sv', heading: 0, fov: 72.2, pitch: 4.8 };

function expectValidGeometry(geometry: FixtureSceneGeometry) {
  for (const anchor of geometry.anchors) {
    expect(NormalizedBoxSchema.safeParse(anchor.box).success).toBe(true);
  }
  for (const box of [
    ...geometry.windows,
    ...geometry.preserveRegions.map((r) => r.box),
    ...geometry.accessRegions.map((r) => r.box),
  ]) {
    expect(NormalizedBoxSchema.safeParse(box).success).toBe(true);
  }
  expect(new Set(geometry.anchors.map((a) => a.id)).size).toBe(geometry.anchors.length);
}

describe('crop and anchor transforms', () => {
  const photo = { width: 2000, height: 1000 };
  const facade: [number, number, number, number] = [0.4, 0.3, 0.6, 0.7];
  const reference = { heading: 90, fov: 80, pitch: 4 };

  it('frames the facade at the reference view and keeps the crop inside the photo', () => {
    const crop = panoramaCrop({ photo, facade, reference, view: reference });
    expect(crop.width).toBe(crop.height);
    expect(crop.left + crop.width / 2).toBeCloseTo(1000, -1);
    expect(crop.top).toBeGreaterThanOrEqual(0);
    expect(crop.top + crop.height).toBeLessThanOrEqual(photo.height);
    // The facade box fits inside the crop.
    expect(transformBox(facade, crop, photo, 1)).not.toBeNull();
  });

  it('pans with heading, tilts with pitch and zooms with fov', () => {
    const base = panoramaCrop({ photo, facade, reference, view: reference });
    const right = panoramaCrop({ photo, facade, reference, view: { ...reference, heading: 105 } });
    expect(right.left).toBeGreaterThan(base.left);
    expect(right.width).toBe(base.width);
    // Headings wrap around north.
    const wrapped = panoramaCrop({
      photo,
      facade,
      reference: { ...reference, heading: 355 },
      view: { ...reference, heading: 10 },
    });
    expect(wrapped.left).toBeGreaterThan(base.left);
    const up = panoramaCrop({ photo, facade, reference, view: { ...reference, pitch: 9 } });
    expect(up.top).toBeLessThanOrEqual(base.top);
    const wide = panoramaCrop({ photo, facade, reference, view: { ...reference, fov: 90 } });
    const narrow = panoramaCrop({ photo, facade, reference, view: { ...reference, fov: 60 } });
    expect(wide.width).toBeGreaterThan(base.width);
    expect(narrow.width).toBeLessThan(base.width);
    // A crop never exceeds the photo, even fully zoomed out.
    const max = panoramaCrop({ photo, facade, reference, view: { ...reference, fov: 500 } });
    expect(max.height).toBeLessThanOrEqual(photo.height);
  });

  it('transforms boxes into crop coordinates, clipping and dropping mostly hidden ones', () => {
    const crop = { left: 500, top: 0, width: 1000, height: 1000 };
    expect(transformBox([0.3, 0.1, 0.5, 0.3], crop, photo)).toEqual([0.1, 0.1, 0.5, 0.3]);
    // Half outside on the left: clipped to the crop edge when at least half is visible.
    expect(transformBox([0.2, 0.1, 0.3, 0.2], crop, photo)).toEqual([0, 0.1, 0.1, 0.2]);
    // Mostly outside: dropped.
    expect(transformBox([0.1, 0.1, 0.27, 0.2], crop, photo)).toBeNull();
    expect(transformBox([0.8, 0.1, 0.9, 0.2], crop, photo)).toBeNull();
  });
});

describe('fixture Street View from real photos', () => {
  const library = loadPhotoLibrary();
  const data = loadFixtureData();

  it('points every owner-facing panorama at a licensed house photo with honest credit', () => {
    for (const place of data.places) {
      for (const panorama of place.panoramas) {
        expect(panorama.house, panorama.panoId).toBeUndefined();
        const photo = library.house(panorama.photo?.photoId ?? '');
        expect(photo, panorama.panoId).toBeDefined();
        expect(panorama.copyright.startsWith('Fixture photo: ')).toBe(true);
        expect(panorama.copyright).not.toMatch(/google/i);
        expect(panorama.copyright).toContain((photo as HousePhoto).photographer);
      }
    }
    const photoOf = (panoId: string) => data.panorama(panoId)?.panorama.photo?.photoId;
    expect(photoOf('fxSvWickerLaneAp21p1Sv')).toBe('house-12-apartments-summer');
    expect(photoOf('fxSvWickerLaneAp21p2Sv')).toBe('house-13-apartments-dusk');
    expect(photoOf('fxSvOrchardBluff11p1Sv')).toBe('house-10-foursquare-halloween-autumn');
    expect(photoOf('fxSvBirchfieldPi04p1Sv')).toBe('house-11-ranch-christmas-winter');
  });

  it('renders a deterministic 640x640 JPEG without any Google mark', async () => {
    const a = await renderFixturePanorama(lanternView);
    const b = await renderFixturePanorama(lanternView);
    expect(a?.checksum).toBe(b?.checksum);
    expect(a?.checksum).toBe(sha256Hex(a?.image ?? Buffer.alloc(0)));
    const meta = await sharp(a?.image).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([640, 640, 'jpeg']);
    const frame = fixturePanoramaFrame(lanternView);
    expect(frame?.kind).toBe('photo');
    expect(frame?.photo?.id).toBe('house-14-victorian-autumn');
  });

  it('returns the manifest anchors transformed into the frame', () => {
    const frame = fixturePanoramaFrame(lanternView);
    if (!frame?.photo || !frame.crop) throw new Error('photo frame');
    const geometry = frame.geometry;
    expectValidGeometry(geometry);
    const categories = new Set(geometry.anchors.map((a) => a.category));
    for (const category of [
      'eaves',
      'front_door',
      'window_frame',
      'porch_rail',
      'column',
      'walkway_edge',
      'planter',
    ]) {
      expect(categories.has(category as never), category).toBe(true);
    }
    // Measured light lines replace the roofline box and measured standing spots replace the
    // steps as places to stand things.
    expect(categories.has('roofline')).toBe(false);
    expect(categories.has('porch_steps')).toBe(false);
    const door = geometry.anchors.find((a) => a.category === 'front_door')?.box;
    expect(door).toEqual(
      transformBox(frame.photo.anchors.frontDoor as never, frame.crop, frame.photo),
    );
    expect(geometry.targetFacade).toBeDefined();
    expect(geometry.attributionRegion).toBeDefined();
    expect(geometry.preserveRegions.some((r) => r.kind === 'logo')).toBe(true);
  });

  it('reflects season, blur, existing decorations and dusk light from the photo', () => {
    const viewOf = (panoId: string) => {
      const found = data.panorama(panoId);
      if (!found) throw new Error(panoId);
      return { panoId, ...referenceView(found.place, found.panorama) };
    };
    expect(fixturePanoramaGeometry(viewOf('fxSvBirchfieldPi04p1Sv'))?.seasonCues.snowVisible).toBe(
      true,
    );
    const blurred = fixturePanoramaGeometry(viewOf('fxSvSitkaSpruceB12p1Sv'));
    expect(blurred?.protectedBlurRegions[0]?.kind).toBe('house');
    const decorated = fixturePanoramaGeometry(viewOf('fxSvOrchardBluff11p1Sv'));
    expect(decorated?.existingDecorations).toMatchObject({
      present: true,
      holidayGuess: 'halloween',
    });
    expect(decorated?.lighting.isDaylight).toBe(false);
    expect(fixturePanoramaGeometry(viewOf('fxSvLanternHillC01p1Sv'))?.lighting.isDaylight).toBe(
      true,
    );
    expect(fixturePanoramaFrame({ ...lanternView, panoId: 'unknown' })).toBeNull();
  });

  it('moves the house in frame when the heading is nudged and zooms with fov', () => {
    const doorAt = (view: typeof lanternView) =>
      fixturePanoramaGeometry(view)?.anchors.find((a) => a.category === 'front_door')?.box;
    const centered = doorAt(lanternView);
    const nudged = doorAt({ ...lanternView, heading: 15 });
    expect(centered && nudged && nudged[0] < centered[0]).toBe(true);
    const wide = doorAt({ ...lanternView, fov: 90 });
    const narrow = doorAt({ ...lanternView, fov: 60 });
    const width = (box?: readonly number[]) => (box ? (box[2] as number) - (box[0] as number) : 0);
    expect(width(narrow)).toBeGreaterThan(width(wide));
  });

  it('keeps the procedural renderer for drawn test scenes', () => {
    const scene = renderHouse({
      house: {
        style: 'colonial',
        stories: 2,
        roofShape: 'gable',
        bodyColor: '#F4F1EA',
        trimColor: '#FFFFFF',
        roofColor: '#3B3F45',
        doorColor: '#8E1B1B',
        porch: 'full',
        windowsPerFloor: 5,
        garage: false,
        shutters: true,
        trees: 'both',
        fence: false,
        season: 'autumn',
        existingDecor: 'none',
        parkedCar: false,
        neighborLeft: false,
        neighborRight: false,
        setbackMeters: 9,
        blurredHouse: false,
      },
      camera: streetViewCamera(
        { heading: 0, fov: 72, pitch: 4.8, width: 640, height: 640 },
        { distanceM: 12, bearingToTargetDeg: 0 },
      ),
      facadeWidthM: 13.5,
      watermark: null,
      seed: 'procedural',
    });
    expectValidGeometry(scene.geometry);
    expect(scene.geometry.anchors.length).toBeGreaterThan(5);
  });
});

describe('hero renditions from real photos', () => {
  const library = loadPhotoLibrary();

  it('crops each orientation at its aspect ratio around the focal point, inside the master', () => {
    for (const slot of ['thanksgiving_us', 'christmas', 'halloween', 'new_years_eve', 'neutral']) {
      const photo = library.hero(slot);
      if (!photo) throw new Error(slot);
      for (const orientation of ['landscape', 'portrait'] as HeroOrientation[]) {
        const crop = heroCropRect(photo, orientation);
        expect(crop.width / crop.height).toBeCloseTo(HERO_ASPECT[orientation], 2);
        expect(crop.left + crop.width).toBeLessThanOrEqual(photo.width);
        expect(crop.top + crop.height).toBeLessThanOrEqual(photo.height);
      }
      // The portrait crop is art-directed toward the portrait focal point, not centered.
      const portrait = heroCropRect(photo, 'portrait');
      const center = (portrait.left + portrait.width / 2) / photo.width;
      const expected = Math.min(
        1 - portrait.width / photo.width / 2,
        Math.max(portrait.width / photo.width / 2, photo.portraitFocal[0]),
      );
      expect(center).toBeCloseTo(expected, 2);
    }
  });

  it('encodes exact sizes in AVIF, WebP and JPEG within the first-load byte budget', async () => {
    const photo = library.hero('thanksgiving_us');
    if (!photo) throw new Error('hero');
    const pixels = await extractHeroCrop(library.pathOf(photo), heroCropRect(photo, 'portrait'));
    for (const format of ['avif', 'webp', 'jpeg'] as const) {
      const { body } = await encodeHeroRendition(pixels, { width: 720, height: 1080 }, format, {
        maxBytes: 200_000,
      });
      const meta = await sharp(body).metadata();
      expect([meta.width, meta.height]).toEqual([720, 1080]);
      expect(meta.format).toBe(format === 'avif' ? 'heif' : format);
      expect(body.length).toBeLessThanOrEqual(200_000);
    }
  });

  it('plans landscape and portrait renditions with photo rights for every hero', () => {
    for (const hero of content.heroes) {
      expect(Object.keys(hero.crops).sort()).toEqual(['landscape', 'portrait']);
      expect(hero.photo?.photoId).toBeDefined();
      expect(hero.rights).toMatchObject({ sourceKind: 'licensed' });
      expect(typeof hero.rights.photographer).toBe('string');
      expect(String(hero.rights.sourceUrl)).toMatch(/^https:\/\//);
      expect(typeof hero.rights.license).toBe('string');
    }
    expect(content.heroFormats.sort()).toEqual(['avif', 'jpeg', 'webp']);
  });
});

describe('generic scenes and upload layouts', () => {
  it('renders every generic scene with valid geometry', () => {
    for (const [sceneId, params] of Object.entries(content.genericScenes)) {
      const scene = renderGenericScene(params, 1200, 900, sceneId);
      expectValidGeometry(scene.geometry);
      expect(scene.geometry.anchors.length).toBeGreaterThan(2);
    }
  });

  it('provides layouts for every scene type and room type', () => {
    for (const sceneType of ['house_exterior', 'apartment_entry', 'balcony', 'interior'] as const) {
      for (const roomType of [
        'dining_room',
        'living_room',
        'entryway',
        'kitchen',
        'bedroom',
        'other',
      ] as const) {
        const geometry = genericUploadGeometry({ sceneType, roomType });
        expectValidGeometry(geometry);
        expect(geometry.anchors.length).toBeGreaterThan(2);
      }
    }
  });
});

describe('decoration compositor', () => {
  it('maps every kit item in the packs to its archetype', () => {
    for (const { pack } of content.packs) {
      for (const section of Object.values(pack.sceneSections)) {
        for (const item of section?.kit ?? []) {
          expect(archetypeFor(item.kitItemId, item.specText), item.kitItemId).toBe(item.archetype);
        }
      }
    }
  });

  it('decorates at the requested size, deterministically, in both lighting modes', async () => {
    const frame = fixturePanoramaFrame(lanternView);
    if (!frame) throw new Error('frame');
    const base = await frame.render({ format: 'png' });
    const pack = content.packFor('christmas')?.pack;
    if (!pack) throw new Error('pack');
    const placements = fixturePlacements({
      pack,
      kit: content.kitFor('christmas', 'house_exterior')?.kit ?? null,
      holidayId: 'christmas',
      sceneType: 'house_exterior',
      style: 'classic',
      lightingMode: 'source',
      geometry: frame.geometry,
    });
    expect(placements.length).toBeGreaterThan(2);
    const input = {
      image: base,
      holidayId: 'christmas' as const,
      style: 'classic' as const,
      sceneType: 'house_exterior' as const,
      placements,
      windows: frame.geometry.windows,
      preserveRegions: frame.geometry.preserveRegions.map((r) => r.box),
      attributionRegion: frame.geometry.attributionRegion ?? null,
      referenceDoor: frame.geometry.anchors.find((a) => a.category === 'front_door')?.box ?? null,
      seed: 'test',
      width: 1024,
      height: 1024,
    };
    const source = await decorateImage({ ...input, lightingMode: 'source' });
    const again = await decorateImage({ ...input, lightingMode: 'source' });
    const evening = await decorateImage({ ...input, lightingMode: 'evening' });
    expect(sha256Hex(source.image)).toBe(sha256Hex(again.image));
    for (const result of [source, evening]) {
      const meta = await sharp(result.image).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([1024, 1024, 'jpeg']);
    }
    // The frame is recognized as a crop of its house photo and decorated on measured anchors;
    // every placement is drawn.
    expect(source.geometry).toBe('library');
    for (const placement of placements) {
      expect(source.drawn[placement.id], placement.kitItemId).toBe(placement.archetype);
    }
    const mean = async (bytes: Buffer) =>
      (await sharp(bytes).stats()).channels.slice(0, 3).reduce((s, c) => s + c.mean, 0);
    expect(await mean(evening.image)).toBeLessThan((await mean(source.image)) * 0.6);
    // The evening grade is cooler: blue gains on red overall.
    const stats = (await sharp(evening.image).stats()).channels;
    const before = (await sharp(source.image).stats()).channels;
    expect((stats[2]?.mean ?? 0) / (stats[0]?.mean ?? 1)).toBeGreaterThan(
      (before[2]?.mean ?? 0) / (before[0]?.mean ?? 1),
    );
  });

  it('never draws inside preserved regions', async () => {
    const base = await sharp({
      create: { width: 400, height: 400, channels: 3, background: '#808080' },
    })
      .png()
      .toBuffer();
    const keep: [number, number, number, number] = [0.3, 0.3, 0.7, 0.7];
    const result = await decorateImage({
      image: base,
      holidayId: 'christmas',
      style: 'abundant',
      lightingMode: 'source',
      sceneType: 'house_exterior',
      placements: [
        {
          id: 'p1',
          kitItemId: 'christmas.house_exterior.garland_evergreen',
          anchorCategory: 'porch_rail',
          region: [0.1, 0.45, 0.9, 0.55],
          placementRule: 'along',
          count: 2,
          lit: true,
        },
      ],
      preserveRegions: [keep],
      anchoredGeometry: true,
      seed: 'keep-out',
      format: 'png',
    });
    const inside = await sharp(result.image)
      .extract({ left: 130, top: 130, width: 140, height: 140 })
      .raw()
      .toBuffer();
    const outside = await sharp(result.image)
      .extract({ left: 40, top: 180, width: 60, height: 40 })
      .stats();
    // Light may spill into the region, but no object is drawn there.
    const darkest = Math.min(...inside);
    expect(darkest).toBeGreaterThanOrEqual(120);
    expect(outside.channels[1]?.min ?? 255).toBeLessThan(100);
  });

  it('restores the burned-in credit verbatim after an evening relight', async () => {
    const frame = fixturePanoramaFrame({ ...lanternView, width: 640, height: 640 });
    const region = frame?.geometry.attributionRegion;
    if (!frame || !region) throw new Error('frame');
    const base = await frame.render({ format: 'png' });
    const result = await decorateImage({
      image: base,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'evening',
      sceneType: 'house_exterior',
      placements: [],
      attributionRegion: region,
      seed: 'attribution',
      format: 'png',
    });
    const box = {
      left: Math.round(region[0] * 640) + 2,
      top: Math.round(region[1] * 640) + 2,
      width: Math.round((region[2] - region[0]) * 640) - 4,
      height: Math.round((region[3] - region[1]) * 640) - 4,
    };
    const before = await sharp(base).extract(box).raw().toBuffer();
    const after = await sharp(result.image).extract(box).raw().toBuffer();
    expect(after.equals(before)).toBe(true);
  });

  it('renders generic test scenes procedurally', async () => {
    const [sceneId, params] = Object.entries(content.genericScenes)[0] ?? [];
    if (!sceneId || !params) throw new Error('generic scene');
    const scene = renderGenericScene(params, 600, 400, sceneId);
    expect((await sharp(await rasterize(scene.svg)).metadata()).height).toBe(400);
  });
});

describe('fixture triggers', () => {
  it('maps file names and places to scenarios', () => {
    expect(renderScenarioForFileName('balcony_repair.png')).toBe('repair_then_pass');
    expect(renderScenarioForFileName('my-house-slow.jpg')).toBe('slow');
    expect(renderScenarioForFileName('Provider-Error.jpg')).toBe('provider_error');
    expect(renderScenarioForFileName('IMG_2041.HEIC')).toBe('pass');
    expect(sceneHintForFileName('thanksgiving-dining.jpg')).toMatchObject({
      sceneType: 'interior',
      roomType: 'dining_room',
    });
    // A name without a scene word carries no hint: the user picks the scene type.
    expect(sceneHintForFileName('IMG_2041.HEIC')).toBeNull();
    const triggers = JSON.parse(
      readFileSync(new URL('../../fixtures/upload-triggers.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    expect(triggers).not.toHaveProperty('sceneDefault');
    expect(renderScenarioForPlace({ panoId: 'fxSvGullwingLane05p1Sv' })).toBe('repair_then_pass');
  });
});

describe('fixture providers', () => {
  const providers = createProviders(testConfig(), { fixtureSlowDelayMs: 30 });
  const image = { bytes: Buffer.alloc(0), width: 1024, height: 1024, checksum: 'c' };

  it('analyzes fixture panoramas with exact geometry and applies the no-anchors scenario', async () => {
    const exact = await providers.vision.analyzeScene({
      image,
      sourceAssetId: 'sa',
      sourceKind: 'fixture',
      sceneType: 'house_exterior',
      fixture: { scene: { kind: 'street_view', ...lanternView } },
    });
    expect(exact.result.anchors).toEqual(fixturePanoramaGeometry(lanternView)?.anchors);
    expect(exact.providerMode).toBe('fixture');
    const occluded = await providers.vision.analyzeScene({
      image,
      sourceAssetId: 'sa',
      sourceKind: 'upload',
      sceneType: 'interior',
      roomType: 'dining_room',
      fixture: { scenario: 'no_anchors' },
    });
    expect(occluded.result.anchors.every((a) => a.confidence < 0.6)).toBe(true);
  });

  it('judges per scenario and attempt', async () => {
    const plan = {
      attemptNumber: 1,
      placements: [],
      sceneType: 'interior',
    } as unknown as DecorationPlan;
    const judge = (scenario: 'pass' | 'repair_then_pass' | 'reject', attemptNumber: 1 | 2) =>
      providers.vision.judge({
        renderAttemptId: 'ra',
        original: image,
        candidate: image,
        plan: { ...plan, attemptNumber },
        fixture: { scenario },
      });
    expect((await judge('pass', 1)).result.major).toEqual([]);
    expect((await judge('repair_then_pass', 1)).result.major[0]?.code).toBe('implausible_decor');
    expect((await judge('repair_then_pass', 2)).result.major).toEqual([]);
    expect((await judge('reject', 2)).result.critical[0]?.code).toBe('structure_changed');
  });

  it('injects editor failures and records the operation before completing', async () => {
    const base = await sharp({
      create: { width: 640, height: 640, channels: 3, background: '#7799aa' },
    })
      .jpeg()
      .toBuffer();
    const request = {
      schemaVersion: '1.0',
      compilerVersion: 'fixture',
      provider: 'fixture',
      modelSnapshot: 'fixture',
      images: [{ role: 'source' as const, width: 1024, height: 1024, checksum: 'c' }],
      instructionText: 'decorate',
      parameters: { size: '1024x1024' },
      settingsHash: 'h',
    };
    const fixture = {
      holidayId: 'halloween' as const,
      style: 'abundant' as const,
      lightingMode: 'source' as const,
      sceneType: 'house_exterior' as const,
      placements: [],
    };
    const options = (attemptId: string) => ({
      attemptId,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    const editor = providers.imageEditor;
    expect(
      await editor.edit(
        request,
        { image: base, fixture: { ...fixture, scenario: 'provider_error' } },
        options('a1'),
      ),
    ).toMatchObject({ status: 'failed', kind: 'provider_error' });
    expect(
      await editor.edit(
        request,
        { image: base, fixture: { ...fixture, scenario: 'moderation' } },
        options('a2'),
      ),
    ).toMatchObject({ status: 'failed', kind: 'moderation_blocked', retryable: false });
    const recorded: string[] = [];
    const done = await editor.edit(
      request,
      { image: base, fixture: { ...fixture, scenario: 'slow' } },
      { ...options('a3'), onOperation: (id) => void recorded.push(id) },
    );
    expect(recorded).toEqual(['fixture:a3']);
    expect(done).toMatchObject({
      status: 'completed',
      width: 1024,
      height: 1024,
      providerMode: 'fixture',
    });
    expect(await editor.getOperation('fixture:a3')).toMatchObject({ status: 'completed' });
  });

  it('screens uploads by file-name trigger', async () => {
    const screen = (fileName: string) =>
      providers.safety.screenUpload({ image, sourceAssetId: 'sa', fixture: { fileName } });
    expect(await screen('receipt-decline.jpg')).toMatchObject({
      outcome: 'declined',
      reasonClass: 'guidance',
      reason: 'not_a_living_space',
    });
    expect(await screen('hold-living.jpg')).toMatchObject({ outcome: 'held' });
    const people = await screen('kids-people-porch.jpg');
    expect(people).toMatchObject({
      outcome: 'admitted',
      peopleDetected: true,
      suggestedCropBox: [0, 0, 0.58, 1],
    });
    const admitted = await screen('thanksgiving-dining.jpg');
    expect(admitted).toMatchObject({ outcome: 'admitted', peopleDetected: false });
    expect(admitted.triage).toMatchObject({ sceneType: 'interior', roomType: 'dining_room' });
  });

  it('fetches fixture frames transiently with a stable checksum and signed display URLs', async () => {
    const view = { ...lanternView, width: 640, height: 640 };
    const a = await providers.streetView.fetchTransient(view);
    const b = await providers.streetView.fetchTransient(view);
    expect(a.checksum).toBe(b.checksum);
    expect(providers.streetView.buildDisplayUrl(view)).toMatch(
      /^http:\/\/localhost:8080\/fixture\/streetview\?pano=fxSvLanternHillC01p1Sv&heading=0\.0&fov=72\.2&pitch=4\.8&size=640x640&sig=/,
    );
  });
});
