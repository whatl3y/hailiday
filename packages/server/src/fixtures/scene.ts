import type {
  AccessRegion,
  Anchor,
  AnchorCategory,
  BuildingForm,
  ExistingDecorations,
  Hazard,
  NormalizedBox,
  PreserveRegion,
  ProtectedBlurRegion,
  RoomType,
  SceneAnalysisModelOutput,
  SceneType,
} from '@hailiday/core';
import { normBox, overlapPx, type PxBox } from './svg.js';

/**
 * Exact geometry of a procedurally drawn scene, in the scene-analysis vocabulary (normalized
 * boxes on the rendered image), plus extras the fixture compositor uses.
 */
export interface FixtureSceneGeometry {
  width: number;
  height: number;
  sceneType: SceneType;
  buildingForm?: BuildingForm;
  roomType?: RoomType;
  targetFacade?: NormalizedBox;
  targetFacadeAmbiguous: boolean;
  anchors: Anchor[];
  preserveRegions: PreserveRegion[];
  accessRegions: AccessRegion[];
  hazards: Hazard[];
  existingDecorations: ExistingDecorations;
  peopleBoxes: NormalizedBox[];
  protectedBlurRegions: ProtectedBlurRegion[];
  lighting: SceneAnalysisModelOutput['lighting'];
  seasonCues: SceneAnalysisModelOutput['seasonCues'];
  qualityFlags: SceneAnalysisModelOutput['qualityFlags'];
  /** Glass areas of existing windows (evening interior glow is drawn only there). */
  windows: NormalizedBox[];
  /** Burned-in attribution strip, restored verbatim after compositing. */
  attributionRegion?: NormalizedBox;
  /** Neighboring facades (everything outside the target facade must stay unchanged). */
  neighborFacades: NormalizedBox[];
  /** Existing light sources (sconces, lamps, chandeliers) that glow in evening mode. */
  lightSources: NormalizedBox[];
}

export interface RenderedScene {
  svg: string;
  geometry: FixtureSceneGeometry;
}

/** Projects a scene geometry onto the model-output subset of a scene analysis. */
export function geometryToModelOutput(geometry: FixtureSceneGeometry): SceneAnalysisModelOutput {
  return {
    sceneType: geometry.sceneType,
    sceneTypeConfidence: 0.96,
    ...(geometry.buildingForm ? { buildingForm: geometry.buildingForm } : {}),
    ...(geometry.roomType ? { roomType: geometry.roomType } : {}),
    ...(geometry.targetFacade ? { targetFacade: geometry.targetFacade } : {}),
    targetFacadeAmbiguous: geometry.targetFacadeAmbiguous,
    anchors: geometry.anchors,
    preserveRegions: geometry.preserveRegions,
    accessRegions: geometry.accessRegions,
    hazards: geometry.hazards,
    existingDecorations: geometry.existingDecorations,
    peopleBoxes: geometry.peopleBoxes,
    protectedBlurRegions: geometry.protectedBlurRegions,
    lighting: geometry.lighting,
    seasonCues: geometry.seasonCues,
    qualityFlags: geometry.qualityFlags,
  };
}

interface PendingAnchor {
  category: AnchorCategory;
  box: PxBox;
  confidence: number;
  note?: string;
}

/**
 * Collects anchors in pixel space, computes occlusion against occluder boxes (trees, cars) and
 * emits normalized anchors with stable IDs (`a1`, `a2`, …) in insertion order.
 */
export class AnchorCollector {
  private readonly pending: PendingAnchor[] = [];
  private readonly occluders: PxBox[] = [];

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {}

  add(category: AnchorCategory, box: PxBox, confidence = 0.93, note?: string): void {
    this.pending.push({ category, box, confidence, ...(note ? { note } : {}) });
  }

  occluder(box: PxBox): void {
    this.occluders.push(box);
  }

  build(minVisible = 0.35): Anchor[] {
    const anchors: Anchor[] = [];
    for (const item of this.pending) {
      const visibleX =
        Math.max(0, Math.min(this.width, item.box.x1) - Math.max(0, item.box.x0)) /
        Math.max(1e-6, item.box.x1 - item.box.x0);
      const visibleY =
        Math.max(0, Math.min(this.height, item.box.y1) - Math.max(0, item.box.y0)) /
        Math.max(1e-6, item.box.y1 - item.box.y0);
      if (visibleX * visibleY < minVisible) continue;
      const box = normBox(item.box, this.width, this.height);
      if (!box) continue;
      const occlusion = Math.min(
        1,
        this.occluders.reduce((sum, occluder) => sum + overlapPx(item.box, occluder), 0),
      );
      const occlusionFraction = Math.round(occlusion * 100) / 100;
      const cut = visibleX * visibleY < 0.95;
      anchors.push({
        id: `a${anchors.length + 1}`,
        category: item.category,
        box,
        confidence: Math.round((cut ? item.confidence - 0.12 : item.confidence) * 100) / 100,
        occluded: occlusionFraction > 0.05,
        ...(occlusionFraction > 0 ? { occlusionFraction } : {}),
        ...(item.note ? { note: item.note } : {}),
      });
    }
    return anchors;
  }
}

/** Default daylight lighting and flags for drawn scenes. */
export const DAYLIGHT: FixtureSceneGeometry['lighting'] = {
  timeOfDay: 'day',
  isDaylight: true,
  exposure: 'normal',
};

export const NO_QUALITY_FLAGS: FixtureSceneGeometry['qualityFlags'] = {
  blur: false,
  lowLight: false,
  heavyOcclusion: false,
  multipleBuildings: false,
  embeddedPhoto: false,
  tooClose: false,
  tooFar: false,
};

export const NO_EXISTING_DECOR: ExistingDecorations = {
  present: false,
  density: 'none',
  boxes: [],
};
