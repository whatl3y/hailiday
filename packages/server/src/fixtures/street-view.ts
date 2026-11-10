import { sha256Hex } from '../ids/index.js';
import { initialBearingDeg, round, viewFovDeg, viewPitchDeg } from '../providers/geo.js';
import {
  loadFixtureData,
  type FixtureData,
  type FixturePanorama,
  type FixturePlace,
} from './data.js';
import { renderHouse, streetViewCamera } from './house.js';
import {
  fixturePhotoCopyright,
  loadPhotoLibrary,
  panoramaCrop,
  photoFrameGeometry,
  renderPhotoFrame,
  type CropRect,
  type HousePhoto,
  type PhotoLibrary,
} from './photos.js';
import type { FixtureSceneGeometry, RenderedScene } from './scene.js';
import { rasterize } from './svg.js';

/** A Street View-shaped request for a fixture panorama. */
export interface FixturePanoramaView {
  panoId: string;
  heading: number;
  fov: number;
  pitch: number;
  width?: number;
  height?: number;
}

/** One fixture panorama frame: its exact geometry and a renderer for its pixels. */
export interface FixtureFrame {
  /** `photo` for a licensed real photograph; `procedural` for the SVG house renderer. */
  kind: 'photo' | 'procedural';
  geometry: FixtureSceneGeometry;
  /** The crop of the photograph (photo frames only). */
  crop: CropRect | null;
  /** The photograph shown (photo frames only). */
  photo: HousePhoto | null;
  render(options?: { format?: 'jpeg' | 'png'; quality?: number }): Promise<Buffer>;
}

/**
 * The view that frames a panorama's target as discovery computes it: heading to the target, the
 * field of view from the facade width and distance, and the pitch from the distance.
 */
export function referenceView(
  place: FixturePlace,
  panorama: FixturePanorama,
): { heading: number; fov: number; pitch: number } {
  const target = place.destinations.targetPoint ?? place.location;
  return {
    heading: round(initialBearingDeg(panorama.location, target), 1),
    fov: round(viewFovDeg(place.destinations.facadeWidthM, panorama.distanceM), 1),
    pitch: round(viewPitchDeg(panorama.distanceM), 1),
  };
}

function photoFrame(
  view: FixturePanoramaView,
  place: FixturePlace,
  panorama: FixturePanorama,
  library: PhotoLibrary,
  watermark: boolean,
): FixtureFrame {
  const settings = panorama.photo;
  const photo = settings ? library.house(settings.photoId) : undefined;
  if (!settings || !photo) {
    throw new Error(`Fixture panorama ${panorama.panoId} names an unknown photo`);
  }
  const width = view.width ?? 640;
  const height = view.height ?? 640;
  const crop = panoramaCrop({
    photo,
    facade: photo.anchors.houseFacade,
    reference: referenceView(place, panorama),
    view,
    aspect: width / height,
    framing: settings.framing,
    shiftX: settings.shiftX,
    shiftY: settings.shiftY,
  });
  // The credit names the photographer and license; fixture frames never carry provider marks.
  const credit = watermark ? fixturePhotoCopyright(photo) : null;
  const frameInput = {
    photo,
    crop,
    width,
    height,
    credit,
    blurredHouse: settings.blurredHouse,
  };
  return {
    kind: 'photo',
    geometry: photoFrameGeometry(frameInput),
    crop,
    photo,
    render: (options = {}) =>
      renderPhotoFrame({ ...frameInput, file: library.pathOf(photo), ...options }),
  };
}

function proceduralScene(
  view: FixturePanoramaView,
  place: FixturePlace,
  panorama: FixturePanorama,
  watermark: boolean,
): RenderedScene | null {
  if (!panorama.house) return null;
  const target = place.destinations.targetPoint ?? place.location;
  const camera = streetViewCamera(
    {
      heading: view.heading,
      fov: view.fov,
      pitch: view.pitch,
      width: view.width ?? 640,
      height: view.height ?? 640,
    },
    {
      distanceM: panorama.distanceM,
      bearingToTargetDeg: initialBearingDeg(panorama.location, target),
    },
  );
  return renderHouse({
    house: panorama.house,
    camera,
    facadeWidthM: place.destinations.facadeWidthM,
    watermark: watermark && panorama.isGoogleImagery ? panorama.copyright : null,
    seed: panorama.panoId,
  });
}

/**
 * The frame of a fixture panorama view, or null for an unknown pano. Owner-facing places show a
 * licensed real photograph panned and zoomed to the view (heading, fov, pitch) with its anchors
 * transformed into the frame; panoramas with procedural parameters use the SVG house renderer.
 */
export function fixturePanoramaFrame(
  view: FixturePanoramaView,
  options: { watermark?: boolean; data?: FixtureData; library?: PhotoLibrary } = {},
): FixtureFrame | null {
  const data = options.data ?? loadFixtureData();
  const found = data.panorama(view.panoId);
  if (!found) return null;
  const { place, panorama } = found;
  const watermark = options.watermark ?? true;
  if (panorama.photo) {
    return photoFrame(view, place, panorama, options.library ?? loadPhotoLibrary(), watermark);
  }
  const scene = proceduralScene(view, place, panorama, watermark);
  if (!scene) return null;
  return {
    kind: 'procedural',
    geometry: scene.geometry,
    crop: null,
    photo: null,
    render: (renderOptions = {}) =>
      rasterize(scene.svg, {
        format: renderOptions.format ?? 'jpeg',
        quality: renderOptions.quality ?? 88,
      }),
  };
}

/** The exact geometry of a fixture panorama view (no pixels are produced). */
export function fixturePanoramaGeometry(
  view: FixturePanoramaView,
  options: { data?: FixtureData } = {},
): FixtureSceneGeometry | null {
  return fixturePanoramaFrame(view, options)?.geometry ?? null;
}

/** Renders a fixture panorama view to JPEG bytes with its checksum and geometry. */
export async function renderFixturePanorama(
  view: FixturePanoramaView,
  options: { watermark?: boolean; data?: FixtureData } = {},
): Promise<{ image: Buffer; checksum: string; geometry: FixtureSceneGeometry } | null> {
  const frame = fixturePanoramaFrame(view, options);
  if (!frame) return null;
  const image = await frame.render({ quality: 88 });
  return { image, checksum: sha256Hex(image), geometry: frame.geometry };
}
