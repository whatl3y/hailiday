import { statSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@holiday/core';
import { sha256Hex } from '../ids/index.js';
import { regionFor } from '../pipeline/plan/geometry.js';
import { decorateImage, editableMask, splitPath } from './compositor.js';
import type { FixturePlacement } from './decor.js';
import { genericUploadGeometry } from './layouts.js';
import { libraryAnchorsOf, loadPhotoLibrary, type DecorPhoto } from './photos.js';
import { recognizeFrameByDoor, recognizeLibraryPhoto } from './recognize.js';
import { loadSprite, renderSprite } from './sprites.js';
import { fixturePanoramaFrame } from './street-view.js';

const library = loadPhotoLibrary();
const lanternView = { panoId: 'fxSvLanternHillC01p1Sv', heading: 0, fov: 72.2, pitch: 4.8 };

const inside = (box: NormalizedBox, [x, y]: readonly [number, number]) =>
  x > box[0] && x < box[2] && y > box[1] && y < box[3];

const shrink = (box: NormalizedBox, k: number): NormalizedBox => {
  const dx = (box[2] - box[0]) * k;
  const dy = (box[3] - box[1]) * k;
  return [box[0] + dx, box[1] + dy, box[2] - dx, box[3] - dy];
};

/** Resamples a polyline at a fixed number of points per segment. */
function along(line: readonly (readonly [number, number])[], steps = 40): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i] as readonly [number, number];
    const b = line[i + 1] as readonly [number, number];
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

async function flat(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

async function region(image: Buffer, box: NormalizedBox, width: number, height: number) {
  return sharp(image)
    .extract({
      left: Math.round(box[0] * width),
      top: Math.round(box[1] * height),
      width: Math.round((box[2] - box[0]) * width),
      height: Math.round((box[3] - box[1]) * height),
    })
    .raw()
    .toBuffer();
}

describe('photographed decoration cutouts', () => {
  const decor = library.photos.filter((photo): photo is DecorPhoto => photo.kind === 'decor');

  it('ships every cutout with its rights and physical data', () => {
    expect(decor.length).toBeGreaterThan(10);
    let bytes = 0;
    for (const photo of decor) {
      expect(['Unsplash License', 'Pexels License', 'CC0 1.0']).toContain(photo.license);
      expect(photo.photographer.length, photo.id).toBeGreaterThan(0);
      expect(photo.sourceUrl).toMatch(/^https:\/\/(unsplash\.com|www\.pexels\.com|commons\.)/);
      expect(photo.decor.sizeMeters).toBeGreaterThan(0.05);
      expect(photo.decor.sizeMeters).toBeLessThan(1.5);
      for (const v of photo.decor.attachPoint) expect(v >= 0 && v <= 1, photo.id).toBe(true);
      if (photo.decor.emitsLight) expect(photo.decor.lightPoint, photo.id).toBeDefined();
      bytes += statSync(library.pathOf(photo)).size;
    }
    expect(bytes).toBeLessThan(15 * 1024 * 1024);
  });

  it('renders a cutout at the requested scale around its attach point', async () => {
    const sprite = await loadSprite('decor-lantern-white');
    for (const scale of [0.1, 0.25, 0.6]) {
      const rendered = renderSprite(sprite, { x: 500, y: 400, scale });
      if (!rendered) throw new Error('no render');
      // The bounding rectangle carries a pixel of margin on each side.
      expect(Math.abs(rendered.height - 2 - sprite.height * scale)).toBeLessThanOrEqual(2);
      expect(Math.abs(rendered.width - 2 - sprite.width * scale)).toBeLessThanOrEqual(2);
      // The attach point (the lantern's base) lands on the target pixel.
      expect(Math.abs(rendered.rect.y1 - 1 - (400 + sprite.height * scale * 0.005))).toBeLessThan(
        3,
      );
    }
  });
});

describe('measured anchors of the library photos', () => {
  it('keeps every light and rail line off windows, door glass and protected areas', () => {
    for (const photo of library.photos) {
      const anchors = libraryAnchorsOf(photo);
      if (!anchors) continue;
      const blocked = [
        ...anchors.windows.map((b) => shrink(b, 0.08)),
        ...anchors.doorGlass.map((b) => shrink(b, 0.08)),
        ...anchors.keepClear,
      ];
      // Light lines are measured clear of glass. A rail may pass in front of a window (the
      // compositor leaves a gap there), but never through door glass or a protected area.
      const glassAndKept = [...anchors.doorGlass.map((b) => shrink(b, 0.08)), ...anchors.keepClear];
      for (const [lines, boxes] of [
        [anchors.eaves, blocked],
        [anchors.rails, glassAndKept],
      ] as const) {
        for (const line of lines) {
          for (const point of along(line)) {
            for (const box of boxes) expect(inside(box, point), `${photo.id} ${point}`).toBe(false);
          }
        }
      }
    }
  });

  it('measures the surface under every standing spot of a house photo', () => {
    for (const photo of library.photos) {
      if (photo.kind !== 'house' || photo.anchors.standSpots.length === 0) continue;
      const { standSpots, standSurfaces } = photo.anchors;
      expect(standSurfaces.length, photo.id).toBe(standSpots.length);
      for (const [i, [x]] of standSpots.entries()) {
        const surface = standSurfaces[i];
        if (!surface) throw new Error(`${photo.id} surface ${i}`);
        expect(surface.from, `${photo.id} ${i}`).toBeLessThan(x);
        expect(surface.to, `${photo.id} ${i}`).toBeGreaterThan(x);
      }
      expect(libraryAnchorsOf(photo)?.standSurfaces).toEqual(standSurfaces);
    }
  });

  it('measures standing spots at the showcase houses', () => {
    for (const id of [
      'house-14-victorian-autumn',
      'house-06-dutchcolonial-summer',
      'house-02-georgian-autumn',
      'house-07-modern-summer',
      'house-04-bungalow-summer',
      'house-03-ranch-spring',
    ]) {
      expect(library.house(id)?.anchors.standSpots.length ?? 0, id).toBeGreaterThanOrEqual(2);
    }
  });

  it('stands things only on measured spots clear of doors, windows and protected areas', () => {
    for (const photo of library.photos) {
      const anchors = libraryAnchorsOf(photo);
      if (!anchors) continue;
      if (photo.kind === 'house') {
        expect(anchors.standSpots).toEqual(photo.anchors.standSpots);
      }
      for (const spot of anchors.standSpots) {
        for (const box of [...anchors.windows, ...anchors.doors, ...anchors.keepClear]) {
          expect(inside(box, spot), `${photo.id} ${spot}`).toBe(false);
        }
      }
    }
  });
});

describe('light strings', () => {
  it('splits a run wherever it would cross a blocked box or leave the allowed area', () => {
    const path: [number, number][] = Array.from({ length: 101 }, (_, i) => [i, 10]);
    const runs = splitPath(path, [{ x0: 30, y0: 0, x1: 50, y1: 20 }], ([x]) => x < 90);
    expect(runs.length).toBe(2);
    for (const run of runs) {
      for (const [x] of run) expect(x <= 30 || (x >= 50 && x < 90)).toBe(true);
    }
  });

  it('never draws bulbs over window glass or a preserved region', async () => {
    const size = 600;
    const window: NormalizedBox = [0.25, 0.25, 0.4, 0.45];
    const keep: NormalizedBox = [0.6, 0.25, 0.75, 0.45];
    const placements: FixturePlacement[] = [
      {
        id: 'lights',
        kitItemId: 'christmas.house_exterior.string_lights_warm_white',
        anchorCategory: 'eaves',
        // The eave line runs straight across the window and the preserved box.
        region: [0.05, 0.3, 0.95, 0.4],
        placementRule: 'along',
        count: 1,
        lit: true,
      },
    ];
    const result = await decorateImage({
      image: await flat(size, size, '#2a2a2a'),
      holidayId: 'christmas',
      style: 'abundant',
      lightingMode: 'source',
      sceneType: 'house_exterior',
      placements,
      windows: [window],
      preserveRegions: [keep],
      referenceDoor: [0.47, 0.5, 0.53, 0.9],
      anchoredGeometry: true,
      seed: 'glass',
      format: 'png',
    });
    expect(result.drawn.lights).toBe('string_lights');
    const brightest = (raw: Buffer) => Math.max(...raw);
    // Bulbs elsewhere on the line are bright; inside the glass and the preserved box (away from
    // their edges, where bloom may spill) nothing is.
    const free = await region(result.image, [0.06, 0.33, 0.2, 0.38], size, size);
    expect(brightest(free)).toBeGreaterThan(200);
    for (const box of [window, keep]) {
      const raw = await region(result.image, shrink(box, 0.2), size, size);
      expect(brightest(raw)).toBeLessThan(140);
    }
  });
});

describe('recognizing library photos', () => {
  it('recognizes a shipped sample at the working size and decorates it on its anchors', async () => {
    const sample = library.photo('sample-dining-room');
    if (!sample) throw new Error('sample');
    const image = await sharp(library.pathOf(sample)).resize(1536, 1024).jpeg().toBuffer();
    const recognized = await recognizeLibraryPhoto(image);
    expect(recognized?.photo.id).toBe('sample-dining-room');
    const anchors = recognized?.anchors;
    if (!anchors) throw new Error('anchors');
    const placements: FixturePlacement[] = [
      {
        id: 'centerpiece',
        kitItemId: 'christmas.interior.table_centerpiece',
        anchorCategory: 'dining_table',
        region: [0.43, 0.62, 0.54, 0.7],
        placementRule: 'on_surface',
        count: 1,
        lit: true,
      },
    ];
    const input = {
      image,
      holidayId: 'christmas' as const,
      style: 'classic' as const,
      lightingMode: 'source' as const,
      sceneType: 'interior' as const,
      placements,
      seed: 'dining',
      format: 'png' as const,
    };
    const first = await decorateImage(input);
    const second = await decorateImage(input);
    expect(first.geometry).toBe('library');
    expect(first.drawn.centerpiece).toBe('centerpiece');
    expect(sha256Hex(first.image)).toBe(sha256Hex(second.image));
    // A plan whose regions hold none of the photo's measured spots places nothing (nothing is
    // ever guessed into place) but still gets the light treatment.
    const elsewhere = await decorateImage({
      ...input,
      placements: [{ ...(placements[0] as FixturePlacement), region: [0.6, 0.05, 0.9, 0.4] }],
    });
    expect(elsewhere.drawn.centerpiece).toBeNull();
    const bare = await decorateImage({ ...input, placements: [] });
    expect(sha256Hex(elsewhere.image)).not.toBe(sha256Hex(bare.image));
  });

  it('recognizes a fixture Street View frame from its door, and nothing else', async () => {
    const frame = fixturePanoramaFrame({ ...lanternView, width: 640, height: 640 });
    if (!frame) throw new Error('frame');
    const image = await frame.render({ format: 'png' });
    const door = frame.geometry.anchors.find((a) => a.category === 'front_door')?.box;
    if (!door) throw new Error('door');
    const recognized = await recognizeFrameByDoor(image, door);
    expect(recognized?.photo.id).toBe('house-14-victorian-autumn');
    // A door measured somewhere else in the frame implies a crop that does not match.
    const shifted: NormalizedBox = [door[0] - 0.2, door[1] - 0.1, door[2] - 0.2, door[3] - 0.1];
    expect(await recognizeFrameByDoor(image, shifted)).toBeNull();
  });

  it('does not mistake an unknown photo for a library photo', async () => {
    const hero = library.hero('neutral');
    if (!hero) throw new Error('hero');
    const image = await sharp(library.pathOf(hero)).resize(1536, 1024).jpeg().toBuffer();
    expect(await recognizeLibraryPhoto(image)).toBeNull();
  });
});

describe('unknown uploads', () => {
  it('get no objects, only the photographic light treatment, and no guessed windows', async () => {
    const hero = library.hero('neutral');
    if (!hero) throw new Error('hero');
    const image = await sharp(library.pathOf(hero)).resize(768, 512).jpeg().toBuffer();
    const geometry = genericUploadGeometry({
      sceneType: 'interior',
      roomType: 'living_room',
      width: 768,
      height: 512,
    });
    const placements: FixturePlacement[] = geometry.anchors.map((anchor, index) => ({
      id: `p${index}`,
      kitItemId: 'christmas.interior.mantel_garland_lit',
      anchorCategory: anchor.category,
      region: anchor.box,
      placementRule: 'along',
      count: 1,
      lit: true,
    }));
    const input = {
      image,
      holidayId: 'christmas' as const,
      style: 'classic' as const,
      sceneType: 'interior' as const,
      placements,
      seed: 'unknown',
      format: 'png' as const,
    };
    const source = await decorateImage({ ...input, lightingMode: 'source' });
    expect(source.geometry).toBe('unplaced');
    expect(Object.values(source.drawn).every((archetype) => archetype === null)).toBe(true);
    // The out-of-focus lights are the only change: without planned regions the frame is kept.
    const untouched = await decorateImage({ ...input, placements: [], lightingMode: 'source' });
    expect(sha256Hex(untouched.image)).not.toBe(sha256Hex(source.image));
    const before = await sharp(image).raw().toBuffer();
    const kept = await sharp(untouched.image).raw().toBuffer();
    let largest = 0;
    for (let i = 0; i < before.length; i += 1) {
      largest = Math.max(largest, Math.abs((before[i] as number) - (kept[i] as number)));
    }
    expect(largest).toBeLessThanOrEqual(1);
    // Windows from a generic layout are guesses: the evening grade ignores them.
    const evening = await decorateImage({ ...input, lightingMode: 'evening', windows: [] });
    const guessed = await decorateImage({
      ...input,
      lightingMode: 'evening',
      windows: geometry.windows,
    });
    expect(sha256Hex(guessed.image)).toBe(sha256Hex(evening.image));
  });
});

describe('the area the pipeline keeps', () => {
  it('keeps the dilation band off steps and doors, but not the planned region itself', () => {
    const size = 200;
    const placement: FixturePlacement = {
      id: 'p',
      kitItemId: 'x',
      anchorCategory: 'planter',
      region: [0.3, 0.3, 0.5, 0.5],
      placementRule: 'beside',
      count: 1,
      lit: false,
    };
    const steps: NormalizedBox = [0.45, 0.2, 0.8, 0.8];
    const at = (mask: Uint8Array, x: number, y: number) =>
      mask[Math.round(y * size) * size + Math.round(x * size)];
    const open = editableMask([placement], size, size);
    const kept = editableMask([placement], size, size, [steps]);
    // In the band beside the region, over the steps: kept only without the opening.
    expect(at(open, 0.505, 0.4)).toBe(1);
    expect(at(kept, 0.505, 0.4)).toBe(0);
    // In the band away from the steps, and inside the region over the steps: kept.
    expect(at(kept, 0.295, 0.4)).toBe(1);
    expect(at(kept, 0.47, 0.4)).toBe(1);
  });
});

describe('exterior decorations seen from the street', () => {
  const frameOf = async () => {
    const frame = fixturePanoramaFrame({ ...lanternView, width: 1024, height: 1024 });
    if (!frame) throw new Error('frame');
    const door = frame.geometry.anchors.find((a) => a.category === 'front_door');
    if (!door) throw new Error('door');
    return { frame, door, image: await frame.render({ format: 'png' }) };
  };
  const base = {
    style: 'classic' as const,
    lightingMode: 'source' as const,
    sceneType: 'house_exterior' as const,
    seed: 'street',
    format: 'png' as const,
  };

  it('hangs a Christmas wreath that fills its planned region, with a red bow that reads', async () => {
    const { frame, door, image } = await frameOf();
    const box = regionFor('centered_on', door, { width: 1024, height: 1024 });
    if (!box) throw new Error('region');
    const result = await decorateImage({
      ...base,
      image,
      holidayId: 'christmas',
      placements: [
        {
          id: 'wreath',
          kitItemId: 'christmas.house_exterior.wreath_evergreen',
          anchorCategory: 'front_door',
          region: box,
          placementRule: 'centered_on',
          count: 1,
          lit: false,
        },
      ],
      referenceDoor: door.box,
      attributionRegion: frame.geometry.attributionRegion ?? null,
    });
    expect(result.drawn.wreath).toBe('wreath');
    const before = await region(image, box, 1024, 1024);
    const after = await region(result.image, box, 1024, 1024);
    let changed = 0;
    let red = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    const w = Math.round((box[2] - box[0]) * 1024);
    for (let p = 0; p < after.length / 3; p += 1) {
      const [r, g, b] = [after[p * 3], after[p * 3 + 1], after[p * 3 + 2]] as number[];
      const d =
        Math.abs((r as number) - (before[p * 3] as number)) +
        Math.abs((g as number) - (before[p * 3 + 1] as number));
      if (d > 30) {
        changed += 1;
        minX = Math.min(minX, p % w);
        maxX = Math.max(maxX, p % w);
      }
      if (
        (r as number) > 70 &&
        (r as number) > 1.8 * (g as number) &&
        (r as number) > 1.8 * (b as number)
      )
        red += 1;
    }
    // The ring spans most of the region's width, and the bow is a solid patch of red.
    expect((maxX - minX) / w).toBeGreaterThan(0.75);
    expect(changed / (after.length / 3)).toBeGreaterThan(0.3);
    expect(red).toBeGreaterThan(25);
  });

  it('keeps a standing group on the surface it was measured on', async () => {
    const { frame, door, image } = await frameOf();
    const photo = library.house('house-14-victorian-autumn');
    if (!photo) throw new Error('photo');
    const recognized = await recognizeFrameByDoor(image, door.box);
    if (!recognized) throw new Error('recognized');
    const [cx0, , cx1] = recognized.crop;
    const toFrame = (x: number) => ((x - cx0) / (cx1 - cx0)) * 1024;
    // The left stair cheek wall, a narrow cap: a whole cluster cannot fit on it.
    const spot = frame.geometry.anchors.filter((a) => a.category === 'planter')[0];
    if (!spot) throw new Error('spot');
    const surface = photo.anchors.standSurfaces[0];
    if (!surface) throw new Error('surface');
    const result = await decorateImage({
      ...base,
      style: 'abundant',
      image,
      holidayId: 'halloween',
      placements: ['a', 'b'].map((id) => ({
        id,
        kitItemId:
          id === 'a'
            ? 'halloween.house_exterior.jack_o_lanterns'
            : 'halloween.house_exterior.pumpkin_group',
        anchorCategory: 'planter' as const,
        region: regionFor('beside', spot, { width: 1024, height: 1024 }) as NormalizedBox,
        placementRule: 'beside' as const,
        count: 1,
        lit: true,
      })),
      referenceDoor: door.box,
      accessRegions: frame.geometry.accessRegions
        .filter((r) => r.kind !== 'door')
        .map((r) => r.box),
      attributionRegion: frame.geometry.attributionRegion ?? null,
    });
    expect(result.drawn.a).toBe('carved_pumpkins');
    const before = await sharp(image).raw().toBuffer();
    const after = await sharp(result.image).raw().toBuffer();
    const top = Math.round(spot.box[1] * 1024);
    const bottom = Math.round(spot.box[3] * 1024) - 4;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let y = top; y < bottom; y += 1) {
      for (let x = 0; x < 1024; x += 1) {
        const i = (y * 1024 + x) * 3;
        const d =
          Math.abs((after[i] as number) - (before[i] as number)) +
          Math.abs((after[i + 2] as number) - (before[i + 2] as number));
        if (d > 60) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
    }
    // Objects (not their soft shadows) stay over the cap, give or take a rounded overhang.
    const slack = 12;
    expect(minX).toBeGreaterThanOrEqual(toFrame(surface.from) - slack);
    expect(maxX).toBeLessThanOrEqual(toFrame(surface.to) + slack);
  });

  it('draws daylight bulbs large enough to read as bulbs', async () => {
    const size = 640;
    const result = await decorateImage({
      ...base,
      image: await flat(size, size, '#6a6a6a'),
      holidayId: 'christmas',
      placements: [
        {
          id: 'lights',
          kitItemId: 'christmas.house_exterior.string_lights_warm_white',
          anchorCategory: 'eaves',
          region: [0.1, 0.3, 0.9, 0.36],
          placementRule: 'along',
          count: 1,
          lit: true,
        },
      ],
      anchoredGeometry: true,
    });
    expect(result.drawn.lights).toBe('string_lights');
    const raw = await sharp(result.image).raw().toBuffer();
    // Warm lit glass: bright and clearly warmer than the grey wall.
    let glass = 0;
    for (let p = 0; p < size * size; p += 1) {
      const r = raw[p * 3] as number;
      const b = raw[p * 3 + 2] as number;
      if (r > 170 && r - b > 40) glass += 1;
    }
    // Bulbs sit about 0.3 m apart on a 0.8-wide run; each shows at least six warm pixels.
    const scale = size / 16;
    const bulbs = (0.8 * size) / (scale * 0.3);
    expect(glass / bulbs).toBeGreaterThan(6);
  });
});
