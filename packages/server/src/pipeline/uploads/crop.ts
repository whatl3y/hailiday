import sharp from 'sharp';
import {
  DEFAULT_UPLOAD_MIN_SHORT_EDGE,
  clampBox,
  intersectBoxes,
  overlapFraction,
  straightenBoxBounds,
  straightenScale,
  type NormalizedBox,
} from '@hailiday/core';
import { toJson, toJsonOrNull, type DbOrTx } from '../../db/client.js';
import type { BoxJson, SourceAsset } from '../../db/schema.js';
import { newId, sha256Hex } from '../../ids/index.js';
import { createAssetPolicy, defaultPolicyTemplate } from '../../policy/index.js';
import type { Storage } from '../../storage/client.js';
import { keys } from '../../storage/keys.js';
import type { Clock } from '../../clock/index.js';

/** Share of a person box that must fall inside a crop for the person to count as still there. */
export const CROP_PERSON_OVERLAP = 0.2;

/**
 * Pixels a straightened crop keeps clear of the turned photo's edge, so no resampled edge pixel
 * (blended with the empty background) reaches the crop.
 */
const STRAIGHTEN_EDGE_INSET_PX = 2;

interface CropPixels {
  bytes: Buffer;
  width: number;
  height: number;
}

/** The pixel rectangle `[left, top, right, bottom)` of a box inside a frame, clamped to it. */
function boxPixels(
  box: NormalizedBox,
  frame: { left: number; top: number; width: number; height: number },
  inset: number,
) {
  const minX = frame.left + inset;
  const minY = frame.top + inset;
  const maxX = frame.left + frame.width - inset;
  const maxY = frame.top + frame.height - inset;
  const left = Math.max(Math.ceil(minX), Math.floor(frame.left + box[0] * frame.width));
  const top = Math.max(Math.ceil(minY), Math.floor(frame.top + box[1] * frame.height));
  const right = Math.min(Math.floor(maxX), Math.ceil(frame.left + box[2] * frame.width));
  const bottom = Math.min(Math.floor(maxY), Math.ceil(frame.top + box[3] * frame.height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Cuts the box out of the photo. With a rotation the photo is first turned about its center
 * (clockwise for positive degrees) and the box is read on the straightened view, which is the
 * centered `width / scale` × `height / scale` part of the turned photo (`straightenScale`), so
 * the crop lies inside the photo and never shows an empty corner.
 */
async function cutCrop(
  original: Uint8Array,
  size: { width: number; height: number },
  box: NormalizedBox,
  rotation: number,
  minShortEdge: number,
): Promise<CropPixels | { tooSmall: { width: number; height: number } }> {
  let source = sharp(original);
  let region: { left: number; top: number; width: number; height: number };
  if (rotation === 0) {
    region = boxPixels(box, { left: 0, top: 0, ...size }, 0);
  } else {
    const turned = await sharp(original)
      .rotate(rotation, { background: '#000000' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const scale = straightenScale(rotation, size.width, size.height);
    const frameWidth = size.width / scale;
    const frameHeight = size.height / scale;
    const frame = {
      left: (turned.info.width - frameWidth) / 2,
      top: (turned.info.height - frameHeight) / 2,
      width: frameWidth,
      height: frameHeight,
    };
    region = boxPixels(box, frame, STRAIGHTEN_EDGE_INSET_PX);
    source = sharp(turned.data, {
      raw: { width: turned.info.width, height: turned.info.height, channels: turned.info.channels },
    });
  }
  if (
    region.width <= 0 ||
    region.height <= 0 ||
    Math.min(region.width, region.height) < minShortEdge
  ) {
    return {
      tooSmall: { width: Math.max(0, region.width), height: Math.max(0, region.height) },
    };
  }
  const bytes = await source.extract(region).jpeg({ quality: 90 }).toBuffer();
  return { bytes, width: region.width, height: region.height };
}

export type CropOutcome =
  | { outcome: 'created'; child: SourceAsset; remainingPeople: NormalizedBox[] }
  | { outcome: 'too_small'; width: number; height: number }
  | { outcome: 'missing_original' };

/** A box of the parent image expressed in the coordinates of a crop of it. */
function remap(box: NormalizedBox, crop: NormalizedBox): NormalizedBox | null {
  const inside = intersectBoxes(box, crop);
  if (!inside) return null;
  const w = crop[2] - crop[0];
  const h = crop[3] - crop[1];
  return clampBox([
    (inside[0] - crop[0]) / w,
    (inside[1] - crop[1]) / h,
    (inside[2] - crop[0]) / w,
    (inside[3] - crop[1]) / h,
  ]);
}

/**
 * The one-tap people crop (uploads spec, people in photos): cuts the normalized original of a
 * ready upload to a normalized box, optionally after straightening it by `rotation` degrees (the
 * box is then normalized on the straightened view), writes the crop as the normalized original
 * of a new child source asset (same lineage, `derivedFromSourceAssetId` and `cropBox` set, its
 * own asset policy) and re-runs people detection geometrically on the parent's boxes, carried
 * through the same rotation. A crop below the minimum short edge is refused. The child is
 * `ready`; it is not yet bound to the project.
 */
export async function createCroppedChild(
  deps: { db: DbOrTx; storage: Storage; clock: Clock },
  input: { parent: SourceAsset; box: NormalizedBox; rotation?: number; minShortEdge?: number },
): Promise<CropOutcome> {
  const { parent, box } = input;
  if (!parent.objectKey) return { outcome: 'missing_original' };
  const original = await deps.storage.get('private', parent.objectKey);
  if (!original) return { outcome: 'missing_original' };
  const meta = await sharp(original.body).metadata();
  const size = {
    width: meta.width ?? parent.width ?? 0,
    height: meta.height ?? parent.height ?? 0,
  };
  const rotation = input.rotation ?? 0;
  const minShortEdge = input.minShortEdge ?? DEFAULT_UPLOAD_MIN_SHORT_EDGE;
  const cut = await cutCrop(original.body, size, box, rotation, minShortEdge);
  if ('tooSmall' in cut) return { outcome: 'too_small', ...cut.tooSmall };
  const { bytes, width: cropWidth, height: cropHeight } = cut;

  // People boxes of the parent, carried onto the straightened view, then into the crop.
  const parentPeople = (parent.peopleBoxes ?? []) as NormalizedBox[];
  const remainingPeople = parentPeople
    .map((person) =>
      rotation === 0
        ? person
        : (straightenBoxBounds(person, rotation, size.width, size.height) as NormalizedBox),
    )
    .filter((person) => overlapFraction(person, box) >= CROP_PERSON_OVERLAP)
    .map((person) => remap(person, box))
    .filter((person): person is NormalizedBox => person !== null);

  const now = deps.clock.now();
  const childId = newId();
  const key = keys.original(parent.ownerId, childId);
  await deps.storage.put({
    bucket: 'private',
    key,
    body: bytes,
    contentType: 'image/jpeg',
    provenance: { sourceKind: 'upload' },
  });
  const policy = await createAssetPolicy(deps.db, {
    subjectKind: 'source_asset',
    subjectId: childId,
    template: defaultPolicyTemplate('upload', { attestationVersion: parent.attestationVersion }),
  });
  const child = await deps.db
    .insertInto('sourceAssets')
    .values({
      id: childId,
      ownerId: parent.ownerId,
      projectId: parent.projectId,
      kind: parent.kind,
      state: 'ready',
      derivedFromSourceAssetId: parent.id,
      objectKey: key,
      checksumSha256: sha256Hex(bytes),
      contentType: 'image/jpeg',
      byteLength: bytes.length,
      width: cropWidth,
      height: cropHeight,
      originalFormat: parent.originalFormat,
      originalByteLength: parent.originalByteLength,
      originalWidth: parent.originalWidth,
      originalHeight: parent.originalHeight,
      orientationApplied: parent.orientationApplied,
      clientPrepared: parent.clientPrepared,
      attestationVersion: parent.attestationVersion,
      attestedAt: parent.attestedAt,
      sceneType: parent.sceneType,
      buildingForm: parent.buildingForm,
      roomType: parent.roomType,
      sceneTypeConfidence: parent.sceneTypeConfidence,
      sceneTypeCorrected: parent.sceneTypeCorrected,
      multiUnitFacade: parent.multiUnitFacade,
      peopleDetected: remainingPeople.length > 0,
      peopleBoxes: remainingPeople.length > 0 ? toJson(remainingPeople as BoxJson[]) : null,
      suggestedCropBox: null,
      peopleResolution: 'cropped',
      cropBox: toJson(box as BoxJson),
      privateOnly: false,
      qualityHints: parent.qualityHints,
      existingDecorations: toJsonOrNull(parent.existingDecorations),
      seasonCues: toJsonOrNull(parent.seasonCues),
      screening: toJsonOrNull(parent.screening),
      holdForReview: false,
      assetPolicyId: policy.id,
      readyAt: now,
      expiresAt: parent.expiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { outcome: 'created', child, remainingPeople };
}
