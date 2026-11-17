import { describe, expect, it } from 'vitest';
import { loadFixtureData } from '../../fixtures/data.js';
import { fixturePanoramaGeometry } from '../../fixtures/street-view.js';
import {
  FIXTURE_LOCATE_CONFIDENCE,
  FIXTURE_ROAD_EQUAL_AREA,
  FIXTURE_ROAD_EQUAL_CENTER,
  createFixtureVisionModel,
  fixtureRoadHome,
  hintedScene,
} from './fixture.js';
import { FRAME_PROMPT_VERSION, FRAME_ROAD_PROMPT_VERSION } from './prompts.js';

const vision = createFixtureVisionModel();
const image = { bytes: new Uint8Array([1]), width: 1024, height: 768 };
const triage = async (fileName: string | null) =>
  (await vision.classifyUpload({ image, fixture: { fileName } })).result;

describe('fixture upload triage', () => {
  it('reports no scene type for a file name without a scene hint', async () => {
    for (const name of ['IMG_2041.HEIC', 'photo.jpg', null]) {
      expect(await triage(name)).toMatchObject({
        subjectClass: 'living_space',
        sceneType: null,
        sceneTypeConfidence: 0,
        roomType: null,
        roomTypeConfidence: null,
        buildingForm: null,
        buildingFormConfidence: null,
      });
    }
    expect(hintedScene('IMG_2041.HEIC')).toBeNull();
  });

  it('keeps every hinted file name as before', async () => {
    for (const hint of loadFixtureData().triggers.sceneHints) {
      const result = await triage(`e2e-${hint.token}-photo.jpg`);
      expect(result.sceneType).toBe(hint.sceneType);
      expect(result.sceneTypeConfidence).toBe(hint.confidence);
    }
    expect(await triage('e2e-front-porch.jpg')).toMatchObject({
      sceneType: 'house_exterior',
      buildingForm: 'detached',
    });
    expect(await triage('e2e-dining-room.jpg')).toMatchObject({
      sceneType: 'interior',
      roomType: 'dining_room',
    });
    expect(await triage('living room.png')).toMatchObject({
      sceneType: 'interior',
      roomType: 'living_room',
    });
  });

  it('keeps declined file names declined with no scene', async () => {
    expect(await triage('decline-kitchen.jpg')).toMatchObject({
      subjectClass: 'other',
      sceneType: null,
      sceneTypeConfidence: 0.2,
      roomType: null,
    });
  });
});

describe('fixture home location', () => {
  it('reports the target facade and ambiguity the scene analysis reports for the frame', async () => {
    const scene = {
      kind: 'street_view' as const,
      panoId: 'fxSvOldQuarryRoa19p1Sv',
      heading: 90,
      fov: 60,
      pitch: 1,
    };
    const frame = { bytes: new Uint8Array([1]), width: 640, height: 640 };
    const located = await vision.locateHome({
      image: frame,
      sourceAssetId: 'source-1',
      fixture: { scene },
    });
    const analysis = await vision.analyzeScene({
      image: { ...frame, checksum: 'abc' },
      sourceAssetId: 'source-1',
      sourceKind: 'street_view',
      sceneType: 'house_exterior',
      fixture: { scene },
    });
    expect(located.result).toEqual({
      home: analysis.result.targetFacade,
      ambiguous: analysis.result.targetFacadeAmbiguous,
      confidence: FIXTURE_LOCATE_CONFIDENCE,
    });
    expect(located.result.home).not.toBeNull();
    expect(located.promptVersion).toBe(FRAME_PROMPT_VERSION);
    expect(located.providerMode).toBe('fixture');
  });
});

describe('fixture home location in a frame from the road', () => {
  const ROAD_P1 = 'fxSvMillpondRoad26p1Sv';
  const ROAD_P2 = 'fxSvMillpondRoad26p2Sv';
  const frame = { bytes: new Uint8Array([1]), width: 640, height: 640 };
  const scene = (panoId: string, heading: number) => ({
    kind: 'street_view' as const,
    panoId,
    heading,
    fov: 90,
    pitch: 3.8,
  });
  const locate = (panoId: string, heading: number, road: boolean) =>
    vision.locateHome({
      image: frame,
      sourceAssetId: 'source-1',
      fixture: { scene: scene(panoId, heading) },
      ...(road ? { target: 'road' as const } : {}),
    });

  it('picks the home nearest the center, else the largest, and none or ambiguous', () => {
    expect(fixtureRoadHome({ neighborFacades: [] })).toEqual({ home: null, ambiguous: false });
    // One home off to the side, also cut by the edge.
    expect(fixtureRoadHome({ targetFacade: [0.84, 0.4, 1, 0.65], neighborFacades: [] })).toEqual({
      home: [0.84, 0.4, 1, 0.65],
      ambiguous: false,
    });
    // A home at the center beside a larger neighbor.
    expect(
      fixtureRoadHome({
        targetFacade: [0.4, 0.4, 0.6, 0.6],
        neighborFacades: [[0.62, 0.1, 1, 0.9]],
      }),
    ).toEqual({ home: [0.4, 0.4, 0.6, 0.6], ambiguous: false });
    // A neighbor nearer the center than the target facade is the home.
    expect(
      fixtureRoadHome({
        targetFacade: [0.05, 0.4, 0.35, 0.6],
        neighborFacades: [[0.42, 0.4, 0.62, 0.6]],
      }),
    ).toEqual({ home: [0.42, 0.4, 0.62, 0.6], ambiguous: false });
    // None reaches the middle third: the largest.
    expect(
      fixtureRoadHome({
        targetFacade: [0, 0.4, 0.2, 0.6],
        neighborFacades: [[0.7, 0.2, 1, 0.8]],
      }),
    ).toEqual({ home: [0.7, 0.2, 1, 0.8], ambiguous: false });
    // Two about equally near and about equally large.
    expect(
      fixtureRoadHome({
        targetFacade: [0.2, 0.3, 0.48, 0.7],
        neighborFacades: [[0.53, 0.3, 0.8, 0.7]],
      }),
    ).toEqual({ home: null, ambiguous: true });
    // About equally near, but one much smaller: not ambiguous, the nearer is the home.
    expect(
      fixtureRoadHome({
        targetFacade: [0.2, 0.3, 0.48, 0.7],
        neighborFacades: [[0.58, 0.45, 0.7, 0.55]],
      }),
    ).toEqual({ home: [0.58, 0.45, 0.7, 0.55], ambiguous: false });
    expect(FIXTURE_ROAD_EQUAL_CENTER).toBe(0.05);
    expect(FIXTURE_ROAD_EQUAL_AREA).toBe(0.7);
  });

  it('answers the road place with the road rule and its prompt version', async () => {
    const facadeAt = (panoId: string, heading: number) =>
      fixturePanoramaGeometry(scene(panoId, heading))?.targetFacade;
    for (const heading of [152, 171.3, 123, 109.9]) {
      const located = await locate(ROAD_P1, heading, true);
      expect(located.result).toEqual({
        home: facadeAt(ROAD_P1, heading),
        ambiguous: false,
        confidence: FIXTURE_LOCATE_CONFIDENCE,
      });
      expect(located.promptVersion).toBe(FRAME_ROAD_PROMPT_VERSION);
    }
    // The edge cuts the home at 109.9.
    expect((await locate(ROAD_P1, 109.9, true)).result.home?.[2]).toBe(1);
    // No home in the views turned away from it.
    for (const heading of [332, 27.6]) {
      expect((await locate(ROAD_P1, heading, true)).result).toEqual({
        home: null,
        ambiguous: false,
        confidence: FIXTURE_LOCATE_CONFIDENCE,
      });
    }
    // Two attached homes either side of the center.
    expect((await locate(ROAD_P2, 192.3, true)).result).toEqual({
      home: null,
      ambiguous: true,
      confidence: FIXTURE_LOCATE_CONFIDENCE,
    });
  });

  it('answers the same frames without a target as before', async () => {
    for (const [panoId, heading] of [
      [ROAD_P1, 152],
      [ROAD_P1, 109.9],
      [ROAD_P1, 332],
      [ROAD_P2, 192.3],
    ] as const) {
      const geometry = fixturePanoramaGeometry(scene(panoId, heading));
      const located = await locate(panoId, heading, false);
      expect(located.result).toEqual({
        home: geometry?.targetFacade ?? null,
        ambiguous: geometry?.targetFacadeAmbiguous,
        confidence: FIXTURE_LOCATE_CONFIDENCE,
      });
      expect(located.promptVersion).toBe(FRAME_PROMPT_VERSION);
    }
    // An aimed frame without a home is ambiguous to the aimed rule.
    expect((await locate(ROAD_P1, 332, false)).result).toMatchObject({
      home: null,
      ambiguous: true,
    });
  });
});
