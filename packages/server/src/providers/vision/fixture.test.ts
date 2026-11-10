import { describe, expect, it } from 'vitest';
import { loadFixtureData } from '../../fixtures/data.js';
import { createFixtureVisionModel, hintedScene } from './fixture.js';

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
