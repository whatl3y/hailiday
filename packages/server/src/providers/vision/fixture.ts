import type {
  JudgeModelOutput,
  NormalizedBox,
  SceneAnalysisModelOutput,
  UploadTriage,
} from '@hailiday/core';
import { loadContent, type Content } from '../../content/load.js';
import { renderGenericScene } from '../../fixtures/art.js';
import {
  loadFixtureData,
  normalizeFileName,
  sceneHintForFileName,
  screeningTriggerFor,
  triggerPeopleBoxes,
  type RenderScenario,
  type SceneHint,
} from '../../fixtures/data.js';
import { fixtureUploadGeometry, genericUploadGeometry } from '../../fixtures/layouts.js';
import { geometryToModelOutput, type FixtureSceneGeometry } from '../../fixtures/scene.js';
import { fixturePanoramaGeometry } from '../../fixtures/street-view.js';
import type {
  AnalyzeSceneInput,
  ImageInput,
  LocalizeAdditionsResult,
  LocateHomeResult,
  VisionModel,
  VisionUsage,
} from '../types.js';
import {
  ANALYSIS_PROMPT_VERSION,
  FRAME_PROMPT_VERSION,
  FRAME_ROAD_PROMPT_VERSION,
  JUDGE_PROMPT_VERSION,
  LOCALIZE_PROMPT_VERSION,
  TRIAGE_PROMPT_VERSION,
} from './prompts.js';
import { toEnhanceJudgeResult, toJudgeResult, toSceneAnalysis } from './records.js';

/**
 * Fixture vision model ID, recorded on scene analyses (and part of their reuse key): a change in
 * what the fixture returns for an image takes a new ID so stored analyses are not reused.
 */
export const FIXTURE_VISION_MODEL = 'fixture-vision-2';
const USAGE: VisionUsage = { inputTokens: 0, outputTokens: 0, calls: 1 };

/** Scene confidence the fixture triage reports when the file name carries no scene hint. */
export const UNHINTED_SCENE_CONFIDENCE = 0;

/** The scene hint a file name carries (first matching token), or null when it carries none. */
export function hintedScene(fileName: string | null | undefined): SceneHint | null {
  if (!fileName) return null;
  const name = ` ${normalizeFileName(fileName)} `;
  const match = loadFixtureData().triggers.sceneHints.find((candidate) => {
    const token = normalizeFileName(candidate.token);
    return token.length > 0 && name.includes(token);
  });
  return match ? sceneHintForFileName(fileName) : null;
}

/** Applies the `no_anchors` scenario: every anchor is low-confidence and heavily occluded. */
function degradeAnchors(output: SceneAnalysisModelOutput): SceneAnalysisModelOutput {
  return {
    ...output,
    anchors: output.anchors.map((anchor) => ({
      ...anchor,
      confidence: 0.35,
      occluded: true,
      occlusionFraction: 0.7,
      note: 'mostly hidden behind foliage',
    })),
    qualityFlags: { ...output.qualityFlags, heavyOcclusion: true },
  };
}

/** Confidence the fixture reports for the home it locates. */
export const FIXTURE_LOCATE_CONFIDENCE = 0.9;

/** Two homes at most this much apart in their distance from the frame's center are equally near. */
export const FIXTURE_ROAD_EQUAL_CENTER = 0.05;
/** Two homes whose smaller area is at least this share of the larger are equally prominent. */
export const FIXTURE_ROAD_EQUAL_AREA = 0.7;

/**
 * The home the fixture locates in a frame taken from the road, from the residential buildings
 * the frame shows (the target facade, then the neighbor facades): among those reaching into the
 * frame's horizontal middle third, the one nearest the center; when none does, the largest
 * anywhere in the frame, also when the frame's edge cuts it. Ambiguous when the next one is about
 * as near the center (within `FIXTURE_ROAD_EQUAL_CENTER`) and about as large (an area ratio of at
 * least `FIXTURE_ROAD_EQUAL_AREA`); no home when the frame shows no residential building.
 */
export function fixtureRoadHome(
  geometry: Pick<FixtureSceneGeometry, 'targetFacade' | 'neighborFacades'>,
): Pick<LocateHomeResult, 'home' | 'ambiguous'> {
  const homes = [
    ...(geometry.targetFacade ? [geometry.targetFacade] : []),
    ...geometry.neighborFacades,
  ];
  if (homes.length === 0) return { home: null, ambiguous: false };
  const centerDistance = (box: NormalizedBox) => Math.abs((box[0] + box[2]) / 2 - 0.5);
  const area = (box: NormalizedBox) => (box[2] - box[0]) * (box[3] - box[1]);
  const near = homes.filter((box) => box[2] > 1 / 3 && box[0] < 2 / 3);
  const ordered =
    near.length > 0
      ? [...near].sort((a, b) => centerDistance(a) - centerDistance(b))
      : [...homes].sort((a, b) => area(b) - area(a));
  const [best, rival] = ordered as [NormalizedBox, NormalizedBox | undefined];
  if (
    rival &&
    Math.abs(centerDistance(rival) - centerDistance(best)) <= FIXTURE_ROAD_EQUAL_CENTER &&
    Math.min(area(best), area(rival)) / Math.max(area(best), area(rival)) >= FIXTURE_ROAD_EQUAL_AREA
  ) {
    return { home: null, ambiguous: true };
  }
  return { home: [...best] as NormalizedBox, ambiguous: false };
}

/**
 * Fixture vision model. Scene analysis returns the exact geometry of procedurally drawn
 * fixtures (Street View panoramas and generic scenes); for uploads it returns the measured anchors
 * when the image is a recognized library photo (a shipped sample or house photo) and a generic
 * layout otherwise. The judge and triage follow the render scenario and the upload file-name
 * triggers. Localization reports every planned placement's region as an added item with its
 * placement id and no other change. Locating the home reports the target facade and ambiguity the
 * scene analysis reports for the same frame; in a frame taken from the road it answers by
 * `fixtureRoadHome` from the residential buildings the frame shows.
 */
export function createFixtureVisionModel(options: { content?: Content } = {}): VisionModel {
  let contentPromise: Promise<Content> | null = options.content
    ? Promise.resolve(options.content)
    : null;
  const content = () => (contentPromise ??= loadContent());

  async function geometryFor(
    input: Pick<AnalyzeSceneInput, 'fixture' | 'sceneType' | 'buildingForm' | 'roomType'> & {
      image: ImageInput;
    },
  ): Promise<FixtureSceneGeometry> {
    const scene = input.fixture?.scene;
    if (scene?.kind === 'street_view') {
      const geometry = fixturePanoramaGeometry(scene);
      if (geometry) return geometry;
    }
    if (scene?.kind === 'generic_scene') {
      const params = (await content()).genericScenes[scene.sceneId];
      if (params)
        return renderGenericScene(params, input.image.width, input.image.height, scene.sceneId)
          .geometry;
    }
    const upload = {
      sceneType: input.sceneType,
      buildingForm: input.buildingForm ?? null,
      roomType: input.roomType ?? null,
      width: input.image.width,
      height: input.image.height,
    };
    // Bytes the recognizer cannot decode are simply not a library photo.
    return fixtureUploadGeometry({ ...upload, image: input.image.bytes }).catch(() =>
      genericUploadGeometry(upload),
    );
  }

  return {
    providerId: 'fixture-vision',
    mode: 'fixture',

    async classifyUpload(input) {
      const started = Date.now();
      const trigger = screeningTriggerFor(input.fixture?.fileName);
      const declined = trigger?.outcome === 'declined';
      // Without a scene hint in the file name the fixture cannot know the scene, so it reports
      // none and the person chooses it.
      const hint = declined ? null : hintedScene(input.fixture?.fileName);
      const triage: UploadTriage = {
        subjectClass: declined ? 'other' : 'living_space',
        sceneType: hint?.sceneType ?? null,
        sceneTypeConfidence: declined ? 0.2 : (hint?.confidence ?? UNHINTED_SCENE_CONFIDENCE),
        roomType: hint?.sceneType === 'interior' ? (hint.roomType ?? 'other') : null,
        roomTypeConfidence: hint?.sceneType === 'interior' ? hint.confidence : null,
        buildingForm:
          hint?.sceneType === 'house_exterior' ? (hint.buildingForm ?? 'detached') : null,
        buildingFormConfidence: hint?.sceneType === 'house_exterior' ? hint.confidence : null,
        multiUnitFacade: false,
        qualityFlags: [],
        existingDecorations: 'none',
        seasonCues: ['unknown'],
        peopleBoxes: triggerPeopleBoxes(trigger),
      };
      return {
        result: triage,
        usage: USAGE,
        model: FIXTURE_VISION_MODEL,
        promptVersion: TRIAGE_PROMPT_VERSION,
        elapsedMs: Date.now() - started,
        providerMode: 'fixture',
      };
    },

    async analyzeScene(input) {
      const started = Date.now();
      const geometry = await geometryFor(input);
      let output = geometryToModelOutput(geometry);
      if (input.fixture?.scenario === 'no_anchors') output = degradeAnchors(output);
      const elapsedMs = Date.now() - started;
      return {
        result: toSceneAnalysis(output, input, {
          analysisModel: FIXTURE_VISION_MODEL,
          analysisPromptVersion: ANALYSIS_PROMPT_VERSION,
          elapsedMs,
        }),
        usage: USAGE,
        model: FIXTURE_VISION_MODEL,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        elapsedMs,
        providerMode: 'fixture',
      };
    },

    async judge(input) {
      const started = Date.now();
      const scenario: RenderScenario = input.fixture?.scenario ?? 'pass';
      const attempt = input.plan.attemptNumber;
      const output: JudgeModelOutput = {
        critical: [],
        major: [],
        placements: input.plan.placements.map((placement) => ({
          placementId: placement.id,
          present: true,
          confidence: 0.9,
          adherence: { category: true, colorFamily: true, count: 'pass', scale: 'ok' },
        })),
        scores: { realism: 4, appeal: 4, planAdherence: 4 },
        overallConfidence: 0.9,
      };
      if (scenario === 'repair_then_pass' && attempt === 1) {
        output.major.push({
          code: 'implausible_decor',
          confidence: 0.86,
          evidence: 'Fixture scenario: the first attempt places one item at an implausible scale.',
        });
        output.scores = { realism: 3, appeal: 3, planAdherence: 3 };
      }
      if (scenario === 'reject') {
        output.critical.push({
          code: 'structure_changed',
          confidence: 0.92,
          evidence: 'Fixture scenario: the roofline and window spacing differ from the original.',
        });
        output.scores = { realism: 2, appeal: 2, planAdherence: 2 };
        output.overallConfidence = 0.88;
      }
      if (scenario === 'relight_reject' && input.mode === 'relight') {
        output.critical.push({
          code: 'structure_changed',
          confidence: 0.92,
          evidence: 'Fixture scenario: the relit picture changes the home, not only its light.',
        });
        output.scores = { realism: 2, appeal: 2, planAdherence: 2 };
        output.overallConfidence = 0.88;
      }
      const elapsedMs = Date.now() - started;
      return {
        result: toJudgeResult(output, input, {
          judgeModel: FIXTURE_VISION_MODEL,
          judgePromptVersion: JUDGE_PROMPT_VERSION,
          elapsedMs,
        }),
        usage: USAGE,
        model: FIXTURE_VISION_MODEL,
        promptVersion: JUDGE_PROMPT_VERSION,
        elapsedMs,
        providerMode: 'fixture',
      };
    },

    async judgeEnhancement(input) {
      const started = Date.now();
      const output: JudgeModelOutput = {
        critical: [],
        major: [],
        placements: [],
        scores: { realism: 4, appeal: 4, planAdherence: 5 },
        overallConfidence: 0.9,
      };
      const elapsedMs = Date.now() - started;
      return {
        result: toEnhanceJudgeResult(output, input, {
          judgeModel: FIXTURE_VISION_MODEL,
          judgePromptVersion: JUDGE_PROMPT_VERSION,
          elapsedMs,
        }),
        usage: USAGE,
        model: FIXTURE_VISION_MODEL,
        promptVersion: JUDGE_PROMPT_VERSION,
        elapsedMs,
        providerMode: 'fixture',
      };
    },

    async locateHome(input) {
      const started = Date.now();
      const geometry = await geometryFor({
        image: input.image,
        sceneType: 'house_exterior',
        ...(input.fixture ? { fixture: input.fixture } : {}),
      });
      const road = input.target === 'road';
      const result: LocateHomeResult = road
        ? { ...fixtureRoadHome(geometry), confidence: FIXTURE_LOCATE_CONFIDENCE }
        : {
            home: geometry.targetFacade ? ([...geometry.targetFacade] as NormalizedBox) : null,
            ambiguous: geometry.targetFacadeAmbiguous,
            confidence: FIXTURE_LOCATE_CONFIDENCE,
          };
      return {
        result,
        usage: USAGE,
        model: FIXTURE_VISION_MODEL,
        promptVersion: road ? FRAME_ROAD_PROMPT_VERSION : FRAME_PROMPT_VERSION,
        elapsedMs: Date.now() - started,
        providerMode: 'fixture',
      };
    },

    async localizeAdditions(input) {
      const started = Date.now();
      const result: LocalizeAdditionsResult = {
        added: input.placements.map((placement) => ({
          label: placement.specText ?? placement.kitItemId,
          box: [...placement.region] as NormalizedBox,
          placementId: placement.id,
        })),
        otherChanges: [],
      };
      return {
        result,
        usage: USAGE,
        model: FIXTURE_VISION_MODEL,
        promptVersion: LOCALIZE_PROMPT_VERSION,
        elapsedMs: Date.now() - started,
        providerMode: 'fixture',
      };
    },
  };
}
