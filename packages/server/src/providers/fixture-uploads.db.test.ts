import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DecorationPlanSchema,
  SceneAnalysisSchema,
  type RoomType,
  type SceneType,
} from '@holiday/core';
import type * as Compositor from '../fixtures/compositor.js';
import type { DecorateInput, DecorateResult } from '../fixtures/compositor.js';
import { genericUploadGeometry } from '../fixtures/layouts.js';
import { loadPhotoLibrary } from '../fixtures/photos.js';
import type { PipelineDeps } from '../pipeline/context.js';
import { runRenderJob } from '../pipeline/render/job.js';
import { readJob } from '../pipeline/render/transitions.js';
import { anchoredGeometryFor } from './image-editor/fixture.js';
import { createFixtureVisionModel } from './vision/fixture.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createUploadSource,
} from '../pipeline/testing.js';

/** Every call the fixture image editor makes to the compositor, with what it drew. */
const compositor = vi.hoisted(() => ({
  calls: [] as { input: DecorateInput; result: DecorateResult }[],
}));

vi.mock('../fixtures/compositor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Compositor>();
  return {
    ...actual,
    async decorateImage(input: DecorateInput) {
      const result = await actual.decorateImage(input);
      compositor.calls.push({ input, result });
      return result;
    },
  };
});

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

async function samplePhoto(id: string): Promise<Buffer> {
  const library = loadPhotoLibrary();
  const photo = library.photo(id);
  if (!photo) throw new Error(`missing library photo ${id}`);
  return readFile(library.pathOf(photo));
}

/** Runs an upload render through the real pipeline and returns its analysis, plan and edit. */
async function renderUpload(input: {
  image: Buffer;
  fileName: string;
  sceneType: SceneType;
  roomType?: RoomType;
}) {
  const { ownerId, projectId, source } = await createUploadSource(deps, input);
  const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
  compositor.calls.length = 0;
  const result = await runRenderJob(deps, { renderJobId: job.id });
  const done = await readJob(deps.db, job.id);
  const analysisRow = await deps.db
    .selectFrom('sceneAnalyses')
    .selectAll()
    .where('sourceAssetId', '=', source.id)
    .executeTakeFirstOrThrow();
  const planRow = await deps.db
    .selectFrom('decorationPlans')
    .selectAll()
    .where('jobId', '=', job.id)
    .orderBy('attemptNo', 'asc')
    .executeTakeFirstOrThrow();
  return {
    result,
    done,
    analysis: SceneAnalysisSchema.parse(analysisRow.document),
    plan: DecorationPlanSchema.parse(planRow.document),
    edits: [...compositor.calls],
  };
}

const overlaps = (a: readonly number[], b: readonly number[]) =>
  (a[0] as number) < (b[2] as number) &&
  (b[0] as number) < (a[2] as number) &&
  (a[1] as number) < (b[3] as number) &&
  (b[1] as number) < (a[3] as number);

describe('fixture upload renders of shipped sample photos', () => {
  for (const sample of [
    { id: 'sample-dining-room', sceneType: 'interior' as const, roomType: 'dining_room' as const },
    { id: 'sample-front-porch', sceneType: 'house_exterior' as const },
  ]) {
    it(`plans on the measured anchors of ${sample.id} and the compositor places objects`, async () => {
      const image = await samplePhoto(sample.id);
      const run = await renderUpload({
        image,
        fileName: `${sample.id}.jpg`,
        sceneType: sample.sceneType,
        ...('roomType' in sample ? { roomType: sample.roomType } : {}),
      });
      expect(run.result.state).toBe('succeeded');

      // Scene analysis carries the measured anchors, not the generic scene-type layout.
      const generic = genericUploadGeometry({
        sceneType: sample.sceneType,
        roomType: 'roomType' in sample ? sample.roomType : null,
      });
      const boxes = (anchors: readonly { category: string; box: readonly number[] }[]) =>
        anchors.map((anchor) => `${anchor.category}:${anchor.box.join(',')}`).sort();
      expect(boxes(run.analysis.anchors)).not.toEqual(boxes(generic.anchors));
      expect(run.analysis.anchors.every((anchor) => anchor.confidence === 0.9)).toBe(true);

      // Every placement sits on one of those measured anchors.
      expect(run.plan.placements.length).toBeGreaterThan(0);
      const byId = new Map(run.analysis.anchors.map((anchor) => [anchor.id, anchor]));
      for (const placement of run.plan.placements) {
        const anchor = byId.get(placement.anchorId);
        expect(anchor?.category).toBe(placement.anchorCategory);
        expect(anchor && overlaps(anchor.box, placement.region)).toBe(true);
      }

      // The compositor recognizes the photo and draws real objects on the planned placements.
      expect(run.edits.length).toBeGreaterThan(0);
      for (const { input, result } of run.edits) {
        expect(input.anchoredGeometry).toBe(false);
        expect(result.geometry).toBe('library');
        expect(input.placements.map((p) => p.region)).toEqual(
          run.plan.placements.map((p) => p.region),
        );
        const drawn = Object.values(result.drawn).filter((archetype) => archetype !== null);
        expect(drawn.length).toBeGreaterThan(0);
      }
    });
  }

  for (const sample of [
    { id: 'sample-dining-room', roomType: 'dining_room' as const },
    { id: 'sample-living-room-mantel', roomType: 'living_room' as const },
  ]) {
    it(`keeps what the editor drew on the windows of ${sample.id} through paste-back`, async () => {
      const image = await samplePhoto(sample.id);
      const run = await renderUpload({
        image,
        fileName: `${sample.id}.jpg`,
        sceneType: 'interior',
        roomType: sample.roomType,
      });
      expect(run.result.state).toBe('succeeded');
      const attempt = await deps.db
        .selectFrom('renderAttempts')
        .select(['candidateObjectKey'])
        .where('jobId', '=', run.done?.id as string)
        .where('attemptNo', '=', 1)
        .executeTakeFirstOrThrow();
      const asset = await deps.db
        .selectFrom('renderAssets')
        .select(['objectKey', 'width', 'height'])
        .where('jobId', '=', run.done?.id as string)
        .executeTakeFirstOrThrow();
      const candidate = await deps.storage.get('private', attempt.candidateObjectKey as string);
      const delivered = await deps.storage.get('private', asset.objectKey);
      const { width, height } = asset;
      const pixels = (bytes: Uint8Array) =>
        sharp(bytes).rotate().resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
      const [before, drawn, after] = await Promise.all([
        pixels(image),
        pixels(candidate?.body as Uint8Array),
        pixels(delivered?.body as Uint8Array),
      ]);
      // Pixels the fixture editor changed strongly, and the share of them the delivered image
      // still shows: a garland drawn deeper than the composite mask is cut off at its edge.
      const moved = (a: Buffer, b: Buffer, i: number) =>
        Math.max(
          Math.abs((a[i] as number) - (b[i] as number)),
          Math.abs((a[i + 1] as number) - (b[i + 1] as number)),
          Math.abs((a[i + 2] as number) - (b[i + 2] as number)),
        ) > 48;
      let painted = 0;
      let kept = 0;
      for (let i = 0; i < before.length; i += 3) {
        if (!moved(before, drawn, i)) continue;
        painted += 1;
        if (moved(before, after, i)) kept += 1;
      }
      expect(painted / (width * height)).toBeGreaterThan(0.01);
      expect(kept / painted).toBeGreaterThan(0.8);
      // The window garland was planned and drawn.
      const window = run.plan.placements.find((p) => p.anchorCategory === 'interior_window');
      expect(window).toBeDefined();
      expect(run.edits[0]?.result.drawn[window?.id as string]).toBe('garland');
    });
  }

  it('still places nothing on an unknown upload', async () => {
    const image = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#7a6a58' },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">' +
              '<rect x="120" y="420" width="960" height="240" fill="#3b2a1e"/>' +
              '<rect x="420" y="90" width="300" height="260" fill="#c9d6e2"/></svg>',
          ),
        },
      ])
      .jpeg()
      .toBuffer();
    const run = await renderUpload({
      image,
      fileName: 'my-dining-room.jpg',
      sceneType: 'interior',
      roomType: 'dining_room',
    });
    expect(run.result.state).toBe('succeeded');
    const generic = genericUploadGeometry({ sceneType: 'interior', roomType: 'dining_room' });
    expect(run.analysis.anchors.map((anchor) => anchor.box)).toEqual(
      generic.anchors.map((anchor) => anchor.box),
    );
    expect(run.edits.length).toBeGreaterThan(0);
    for (const { result } of run.edits) {
      expect(result.geometry).toBe('unplaced');
      expect(Object.values(result.drawn).every((archetype) => archetype === null)).toBe(true);
    }
    expect(run.done?.state).toBe('succeeded');
  });
});

describe('fixture editor geometry mode', () => {
  const base = {
    holidayId: 'christmas' as const,
    style: 'classic' as const,
    lightingMode: 'source' as const,
    sceneType: 'interior' as const,
    placements: [],
  };

  it('anchors drawn scenes, never uploads, and leaves Street View frames to the compositor', () => {
    expect(anchoredGeometryFor({ ...base, scene: { kind: 'generic_scene', sceneId: 's' } })).toBe(
      true,
    );
    expect(anchoredGeometryFor({ ...base, scene: { kind: 'upload' } })).toBe(false);
    expect(
      anchoredGeometryFor({
        ...base,
        scene: { kind: 'street_view', panoId: 'p', heading: 0, fov: 80, pitch: 0 },
      }),
    ).toBeUndefined();
    expect(anchoredGeometryFor(base)).toBeUndefined();
  });
});

describe('fixture vision upload analysis', () => {
  it('treats bytes it cannot decode as an unknown photo (generic layout)', async () => {
    const vision = createFixtureVisionModel({ content: deps.content });
    const analysis = await vision.analyzeScene({
      image: { bytes: Buffer.alloc(0), width: 1536, height: 1024, checksum: 'c' },
      sourceAssetId: 'sa',
      sourceKind: 'upload',
      sceneType: 'balcony',
    });
    expect(analysis.result.anchors.map((anchor) => anchor.box)).toEqual(
      genericUploadGeometry({ sceneType: 'balcony' }).anchors.map((anchor) => anchor.box),
    );
  });
});
