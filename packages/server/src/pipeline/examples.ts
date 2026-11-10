import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  SCENE_ANALYSIS_SCHEMA_VERSION,
  SpecAttributesSchema,
  type BuildingForm,
  type NormalizedBox,
  type Placement,
  type RoomType,
  type SceneAnalysis,
  type SpecAttributes,
} from '@holiday/core';
import type { ImageEditSettings } from '../config/index.js';
import type { Content, ExampleContent } from '../content/load.js';
import type { Db } from '../db/client.js';
import { toJson } from '../db/client.js';
import { geometryToModelOutput, type FixtureSceneGeometry } from '../fixtures/scene.js';
import { genericUploadGeometry } from '../fixtures/layouts.js';
import {
  loadPhotoLibrary,
  photoFrameGeometry,
  type LibraryPhoto,
  type PhotoLibrary,
} from '../fixtures/photos.js';
import { PROVIDER_MODE_METADATA } from '../fixtures/seed-steps.js';
import { sha256Hex } from '../ids/index.js';
import type { Logger } from '../logger/index.js';
import type { FixtureEditContext, ImageEditor, VisionModel } from '../providers/types.js';
import type { Storage } from '../storage/client.js';
import { CARD_CACHE_CONTROL } from '../storage/client.js';
import { compileRelightRequest, compilerProviderFor } from './compile/compiler.js';
import type { PhotometricRecord } from './imaging/composite.js';
import {
  buildCompositeMask,
  compositeProtection,
  dilationHang,
  placementMaskParts,
  type CompositeMask,
} from './imaging/mask.js';
import { checksumOf, encodeMaskPng, encodePng, type Raster } from './imaging/raster.js';
import type { AlignmentRecord } from './imaging/registration.js';
import { prepareWorkingImage, type WorkingImage } from './imaging/working.js';
import { planAndCompile, type PlanDraft } from './plan/index.js';
import { localizedKeepMask } from './render/mask.js';
import {
  callLocalizer,
  compositeAndCheck,
  localizationRecords,
  registerOutput,
} from './render/quality.js';
import { PIPELINE_DEFAULTS, compilerVersionFor } from './versions.js';

/** The photo an example is rendered from (`source.photoId` in examples.json). */
export function examplePhoto(example: ExampleContent, library: PhotoLibrary): LibraryPhoto {
  const photoId = (example.source as { photoId?: unknown }).photoId;
  const photo = typeof photoId === 'string' ? library.photo(photoId) : undefined;
  if (!photo) throw new Error(`Example ${example.exampleId} names no photo in the library`);
  return photo;
}

/** Exact geometry of a library photo on the working grid (house anchors from the manifest). */
function photoGeometry(
  photo: LibraryPhoto,
  example: ExampleContent,
  working: WorkingImage,
): FixtureSceneGeometry {
  const source = example.source as { roomType?: RoomType; buildingForm?: BuildingForm };
  if (photo.kind === 'house' && !working.contentBox) {
    const [x0, y0, x1, y1] = working.cropBox ?? [0, 0, 1, 1];
    return photoFrameGeometry({
      photo,
      crop: {
        left: Math.round(x0 * photo.width),
        top: Math.round(y0 * photo.height),
        width: Math.round((x1 - x0) * photo.width),
        height: Math.round((y1 - y0) * photo.height),
      },
      width: working.width,
      height: working.height,
      credit: null,
    });
  }
  return genericUploadGeometry({
    sceneType: example.sceneType,
    buildingForm: source.buildingForm ?? null,
    roomType: source.roomType ?? null,
    width: working.width,
    height: working.height,
  });
}

/**
 * An example output whose framing changed beyond what registration can align (the render job
 * reports `camera_changed` for the same output). Carries the registration and the raw output.
 */
export class ExampleCameraChangedError extends Error {
  readonly alignment: AlignmentRecord;
  readonly rawOutput: Uint8Array;
  constructor(exampleId: string, alignment: AlignmentRecord, rawOutput: Uint8Array) {
    super(
      `Example ${exampleId}: the output's framing changed beyond registration (${alignment.reason ?? 'rejected'})`,
    );
    this.name = 'ExampleCameraChangedError';
    this.alignment = alignment;
    this.rawOutput = rawOutput;
  }
}

export interface ExampleRenderDeps {
  content: Content;
  imageEditor: ImageEditor;
  vision: VisionModel;
  /** Spec attributes of the published style kit (`kit_items.spec_attributes`), if known. */
  kitAttributes?: ReadonlyMap<string, SpecAttributes>;
  styleKitVersionId: string;
  modelSnapshot: string;
  library?: PhotoLibrary;
  timeoutMs?: number;
  /**
   * The configured request settings (`AppConfig.imageEdit`: provider mask policy, OpenAI
   * quality, Gemini size and thinking level), as the render job compiles them. Unset fields take
   * the defaults.
   */
  imageEdit?: Partial<ImageEditSettings>;
  /**
   * Daylight composites already rendered in this run, by photo, holiday, scene and style: an
   * evening example relights the daylight example of the same photo instead of rendering it again.
   */
  daylight?: Map<string, ExampleDaylight>;
}

/** The daylight (`source`) composite of an example photo, the base of its evening relight. */
export interface ExampleDaylight {
  candidate: Raster;
  plan: PlanDraft;
  /** Localized decorations kept beyond the plan's shapes. */
  keptRegions: NormalizedBox[];
  alignment: AlignmentRecord;
  photometric: PhotometricRecord | null;
}

function daylightKey(example: ExampleContent, photo: LibraryPhoto): string {
  return [photo.id, example.holidayId, example.sceneType, example.style].join('|');
}

/**
 * Renders one example pair from its licensed photograph through the given image editor with the
 * render job's own functions: working image, scene analysis (the vision model, or the manifest's
 * exact anchors when vision runs in fixture mode), the pack's plan and the request compiled with
 * the configured settings (`imageEdit`), the edit, registration, localization of the added
 * decorations, the keep-mask (the plan's shapes united with the localized boxes), photometric
 * alignment and paste-back. An evening example relights that daylight composite with the compiled
 * relight request (no mask) and registers the relit output to it, as the evening variant of a
 * render job does. Returns JPEG bytes of the before and after images at the example's size, and
 * for an evening example the daylight composite it relit (JPEG at the same size) with its plan.
 */
export async function renderExamplePair(
  deps: ExampleRenderDeps,
  example: ExampleContent,
): Promise<{
  before: Buffer;
  after: Buffer;
  placements: number;
  alignment: AlignmentRecord;
  photometric: PhotometricRecord | null;
  relightBase?: { image: Buffer; plan: PlanDraft };
}> {
  const library = deps.library ?? loadPhotoLibrary();
  const photo = examplePhoto(example, library);
  const bytes = await readFile(library.pathOf(photo));
  const working = await prepareWorkingImage(bytes, 'upload');
  const source = example.source as { roomType?: RoomType; buildingForm?: BuildingForm };
  const image = {
    bytes: working.png,
    width: working.width,
    height: working.height,
    checksum: working.checksum,
  };
  let analysis: SceneAnalysis;
  if (deps.vision.mode === 'live') {
    analysis = (
      await deps.vision.analyzeScene({
        image,
        sourceAssetId: example.exampleId,
        sourceKind: 'upload',
        sceneType: example.sceneType,
        ...(source.roomType ? { roomType: source.roomType } : {}),
        ...(source.buildingForm ? { buildingForm: source.buildingForm } : {}),
      })
    ).result;
  } else {
    analysis = {
      schemaVersion: SCENE_ANALYSIS_SCHEMA_VERSION,
      sourceAssetId: example.exampleId,
      workingImage: { width: working.width, height: working.height, checksum: working.checksum },
      ...geometryToModelOutput(photoGeometry(photo, example, working)),
      sceneTypeMismatch: false,
      model: { analysisModel: 'photo-manifest', analysisPromptVersion: 'manifest' },
      elapsedMs: 0,
    };
  }
  const pack = deps.content.packFor(example.holidayId);
  if (!pack) throw new Error(`No pack for ${example.holidayId}`);
  const provider =
    deps.imageEditor.mode === 'fixture'
      ? 'fixture'
      : compilerProviderFor(deps.imageEditor.providerId);
  const windows = analysis.anchors
    .filter((a) => a.category === 'window_frame' || a.category === 'interior_window')
    .map((a) => a.box);
  const maskFor = (
    placements: readonly Pick<Placement, 'anchorId' | 'placementRule' | 'region' | 'maskShapes'>[],
  ): CompositeMask => {
    // A window's own garland is a band, so its interior is protected below the band dilation.
    const protection = compositeProtection(
      analysis,
      placements,
      dilationHang(PIPELINE_DEFAULTS.bandDilationFraction, working.width, working.height),
    );
    return buildCompositeMask({
      width: working.width,
      height: working.height,
      ...placementMaskParts(placements),
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      bandDilationFraction: PIPELINE_DEFAULTS.bandDilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
      exclusions: [
        ...analysis.preserveRegions
          .filter((region) => ['house_number', 'sign', 'logo'].includes(region.kind))
          .map((region) => region.box),
        ...working.padRegions,
        ...protection.exclusions,
      ],
      access: protection.keepOuts,
    });
  };
  const fixtureContext = (
    placements: readonly Placement[],
    lightingMode: 'source' | 'evening',
  ): { fixture: FixtureEditContext } | Record<string, never> =>
    deps.imageEditor.mode === 'fixture'
      ? {
          fixture: {
            scenario: 'pass' as const,
            holidayId: example.holidayId,
            style: example.style,
            lightingMode,
            sceneType: example.sceneType,
            placements: placements.map((placement) => ({
              id: placement.id,
              kitItemId: placement.kitItemId,
              anchorCategory: placement.anchorCategory,
              region: placement.region,
              placementRule: placement.placementRule,
              count: placement.count,
              lit: placement.lit,
              specText: placement.specText,
            })),
            windows,
            preserveRegions: analysis.preserveRegions.map((region) => region.box),
          },
        }
      : {};
  const edit = async (
    request: Parameters<ImageEditor['edit']>[0],
    input: Parameters<ImageEditor['edit']>[1],
    stage: string,
  ) => {
    const controller = new AbortController();
    const outcome = await deps.imageEditor.edit(request, input, {
      attemptId: `example-${sha256Hex(`${example.exampleId}:${stage}`).slice(0, 16)}`,
      timeoutMs: deps.timeoutMs ?? PIPELINE_DEFAULTS.renderTimeoutMs,
      signal: controller.signal,
    });
    if (outcome.status !== 'completed') {
      throw new Error(
        `Example ${example.exampleId}: the image editor returned ${outcome.status}${'kind' in outcome ? ` (${outcome.kind})` : ''}`,
      );
    }
    return outcome;
  };

  // The daylight composite: this example itself in `source` lighting, or the base of an evening
  // example (reused when the daylight example of the same photo was rendered in this run).
  const key = daylightKey(example, photo);
  let daylight = deps.daylight?.get(key);
  if (!daylight) {
    const planned = planAndCompile(
      {
        renderJobId: example.exampleId,
        planVersion: 1,
        sourceAssetId: example.exampleId,
        sceneAnalysisId: example.exampleId,
        analysis,
        sourceKind: 'upload',
        pack: pack.pack,
        holidayPackVersion: pack.version,
        styleKitVersionId: deps.styleKitVersionId,
        ...(deps.kitAttributes ? { kitAttributes: deps.kitAttributes } : {}),
        sceneType: example.sceneType,
        buildingForm: source.buildingForm ?? null,
        roomType: source.roomType ?? null,
        style: example.style,
        lightingMode: 'source',
        compilerVersion: compilerVersionFor(provider),
        permissionEvaluationId: `example:${example.exampleId}`,
      },
      (built) => {
        const mask = maskFor(built.draft.placements);
        return {
          provider,
          modelSnapshot: deps.modelSnapshot,
          working: { width: working.width, height: working.height, checksum: working.checksum },
          mask: { width: mask.width, height: mask.height, checksum: mask.checksum },
          supportsMask: deps.imageEditor.capabilities.supportsMask,
          ...(deps.imageEdit ? { settings: deps.imageEdit } : {}),
        };
      },
    );
    if (!planned.compile) {
      throw new Error(
        `Example ${example.exampleId}: the plan failed validation (${planned.built.validator.failure ?? 'unknown'})`,
      );
    }
    const plan = planned.built.draft;
    const planMask = maskFor(plan.placements);
    const request = planned.compile.request;
    const outcome = await edit(
      request,
      {
        image: working.png,
        ...(request.mask
          ? { mask: await encodeMaskPng(planMask.hard, planMask.width, planMask.height) }
          : {}),
        ...fixtureContext(plan.placements, 'source'),
      },
      'daylight',
    );
    // The render job's path: registration onto the working grid, localization of what the editor
    // added, then the keep-mask, tone matching and paste-back of the original outside it.
    const registration = await registerOutput({
      working,
      rawBytes: outcome.image,
      plan,
      mask: planMask,
      glowRegions: windows,
    });
    if (!registration.registered.aligned) {
      throw new ExampleCameraChangedError(
        example.exampleId,
        registration.registered.record,
        outcome.image,
      );
    }
    let mask = planMask;
    let keptRegions: NormalizedBox[] = [];
    try {
      const localized = await callLocalizer({
        vision: deps.vision,
        attemptId: example.exampleId,
        working,
        aligned: registration.registered.aligned,
        placements: plan.placements,
        timeoutMs: PIPELINE_DEFAULTS.localizationTimeoutMs,
        signal: new AbortController().signal,
      });
      const keep = localizedKeepMask({
        planMask,
        items: localizationRecords(
          localized.result,
          plan.placements.map((placement) => placement.id),
        ).items,
        analysis,
        attributionRegions: [],
        padRegions: working.padRegions,
      });
      mask = keep.mask;
      keptRegions = keep.kept.map((item) => item.box);
    } catch {
      // As in the render job: a localization that fails keeps the plan mask.
    }
    const composite = await compositeAndCheck({
      working,
      rawBytes: outcome.image,
      registration,
      requested: { width: working.width, height: working.height },
      plan,
      analysis,
      mask,
      keptRegions,
      attributionRegion: null,
      glowRegions: windows,
    });
    daylight = {
      candidate: composite.candidate,
      plan,
      keptRegions,
      alignment: composite.alignment,
      photometric: composite.photometric,
    };
    deps.daylight?.set(key, daylight);
  }

  let candidate = daylight.candidate;
  let alignment = daylight.alignment;
  let photometric = daylight.photometric;
  if (example.lightingMode === 'evening') {
    // The evening example: the editor relights the daylight composite (no mask), and the relit
    // output is registered to it and restored at the padding like the render job's relight.
    const png = await encodePng(daylight.candidate);
    const request = compileRelightRequest({
      basePlan: daylight.plan,
      provider,
      ...(deps.imageEdit ? { settings: deps.imageEdit } : {}),
      modelSnapshot: deps.modelSnapshot,
      image: { width: working.width, height: working.height, checksum: checksumOf(png) },
      compilerVersion: compilerVersionFor(provider),
    });
    const outcome = await edit(
      request,
      { image: png, ...fixtureContext(daylight.plan.placements, 'evening') },
      'evening',
    );
    const relight = await compositeAndCheck({
      working,
      reference: daylight.candidate,
      rawBytes: outcome.image,
      requested: { width: working.width, height: working.height },
      plan: {
        ...daylight.plan,
        lightingMode: 'evening',
        fidelityMode: 'global_relight',
      },
      analysis,
      mask: null,
      keptRegions: daylight.keptRegions,
      attributionRegion: null,
      glowRegions: windows,
    });
    if (!relight.alignment.accepted) {
      throw new ExampleCameraChangedError(example.exampleId, relight.alignment, outcome.image);
    }
    candidate = relight.candidate;
    alignment = relight.alignment;
    photometric = null;
  }
  const encode = (data: Buffer, w: number, h: number) =>
    sharp(data, { raw: { width: w, height: h, channels: 3 } })
      .resize(example.width, example.height, { fit: 'cover', kernel: 'lanczos3' })
      .jpeg({ quality: 88, progressive: true, mozjpeg: true })
      .toBuffer();
  return {
    before: await encode(working.raster.data, working.width, working.height),
    after: await encode(candidate.data, candidate.width, candidate.height),
    placements: daylight.plan.placements.length,
    alignment,
    photometric,
    ...(example.lightingMode === 'evening'
      ? {
          relightBase: {
            image: await encode(
              daylight.candidate.data,
              daylight.candidate.width,
              daylight.candidate.height,
            ),
            plan: daylight.plan,
          },
        }
      : {}),
  };
}

/** Spec attributes and the ID of the published style kit for a holiday and scene type. */
export async function publishedKit(
  db: Db,
  example: Pick<ExampleContent, 'holidayId' | 'sceneType'>,
): Promise<{ id: string; attributes: Map<string, SpecAttributes> } | null> {
  const kit = await db
    .selectFrom('styleKits')
    .select('id')
    .where('kitKey', '=', `${example.holidayId}.${example.sceneType}`)
    .where('status', '=', 'published')
    .executeTakeFirst();
  if (!kit) return null;
  const items = await db
    .selectFrom('kitItems')
    .select(['kitItemId', 'specAttributes'])
    .where('kitId', '=', kit.id)
    .execute();
  const attributes = new Map<string, SpecAttributes>();
  for (const item of items) {
    const parsed = SpecAttributesSchema.safeParse(item.specAttributes);
    if (parsed.success) attributes.set(item.kitItemId, parsed.data);
  }
  return { id: kit.id, attributes };
}

/**
 * Renders every example pair live and publishes it: uploads the before and after images (marked
 * as live renders, which the seed keeps), records the rights and activates the row.
 */
export async function renderAndPublishExamples(deps: {
  db: Db;
  storage: Storage;
  content: Content;
  imageEditor: ImageEditor;
  vision: VisionModel;
  modelSnapshot: string;
  logger: Logger;
  only?: string | null;
  /** The configured request settings (`AppConfig.imageEdit`). */
  imageEdit?: Partial<ImageEditSettings>;
}): Promise<{ rendered: number; failed: number }> {
  let rendered = 0;
  let failed = 0;
  const library = loadPhotoLibrary();
  const daylight = new Map<string, ExampleDaylight>();
  for (const example of deps.content.examples) {
    if (deps.only && example.exampleId !== deps.only) continue;
    const row = await deps.db
      .selectFrom('exampleAssets')
      .select(['id', 'beforeCdnPath', 'afterCdnPath'])
      .where('assetKey', '=', example.exampleId)
      .executeTakeFirst();
    const kit = await publishedKit(deps.db, example);
    if (!row || !kit) {
      deps.logger.warn(
        { exampleId: example.exampleId },
        'example row or kit missing; run the seed',
      );
      failed += 1;
      continue;
    }
    try {
      const pair = await renderExamplePair(
        {
          content: deps.content,
          imageEditor: deps.imageEditor,
          vision: deps.vision,
          kitAttributes: kit.attributes,
          styleKitVersionId: kit.id,
          modelSnapshot: deps.modelSnapshot,
          library,
          daylight,
          ...(deps.imageEdit ? { imageEdit: deps.imageEdit } : {}),
        },
        example,
      );
      const metadata = { [PROVIDER_MODE_METADATA]: deps.imageEditor.mode };
      for (const [key, body] of [
        [row.beforeCdnPath, pair.before],
        [row.afterCdnPath, pair.after],
      ] as const) {
        await deps.storage.put({
          bucket: 'public',
          key,
          body,
          contentType: 'image/jpeg',
          cacheControl: CARD_CACHE_CONTROL,
          metadata,
          provenance: { sourceKind: 'system' },
        });
      }
      await deps.db
        .updateTable('exampleAssets')
        .set({
          active: deps.imageEditor.mode === 'live',
          rights: toJson({
            ...example.rights,
            renderedBy: deps.modelSnapshot,
            packVersion: example.packVersion,
          }),
        })
        .where('id', '=', row.id)
        .execute();
      rendered += 1;
      deps.logger.info(
        { exampleId: example.exampleId, placements: pair.placements },
        'example rendered',
      );
    } catch (error) {
      failed += 1;
      deps.logger.error({ err: error, exampleId: example.exampleId }, 'example render failed');
    }
  }
  return { rendered, failed };
}
