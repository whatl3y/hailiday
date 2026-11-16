import {
  GalleryQuerySchema,
  GalleryResponseSchema,
  SceneTypeSchema,
  type GalleryAttribution,
  type GalleryItem,
  type SceneType,
} from '@hailiday/core';
import { sql, type DbOrTx } from '@hailiday/server/db';
import { hmacSha256Hex } from '@hailiday/server/ids';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import {
  MICROSECOND_TIMESTAMP_FORMAT,
  decodePreciseCursor,
  encodePreciseCursor,
} from '../http/cursor.js';
import { currentAuth } from '../auth/session.js';
import {
  lookPredatesFraming,
  streetViewCreditOf,
  streetViewSourcePermissions,
} from '../domain/sources.js';

/** Display address bases that store the address text on the property. */
const STORED_ADDRESS_BASES = ['manual_entry', 'geocoding_place_id'] as const;
const DOWNLOAD_DISPOSITION = 'attachment; filename="hailiday-preview.jpg"';

/**
 * The group key of a place: the same for every project of an owner at the place, and opaque (a
 * keyed hash, so the place ID itself never reaches the client through the gallery).
 */
export function placeGroupKey(deps: Pick<ApiDeps, 'config'>, placeId: string): string {
  return `place-${hmacSha256Hex(deps.config.sessionSecret, `gallery:place:${placeId}`).slice(0, 32)}`;
}

/** The scene type a rendering was made for, resolved the way the render job resolved it. */
function sceneTypeOf(snapshot: unknown, sourceSceneType: SceneType | null): SceneType {
  const parsed = SceneTypeSchema.safeParse((snapshot as { sceneType?: unknown } | null)?.sceneType);
  return parsed.success ? parsed.data : (sourceSceneType ?? 'house_exterior');
}

/**
 * One page of an owner's gallery rows, newest first by `(created_at, id)` on the stored values
 * (so the `render_assets (owner_id, created_at, id)` index serves both the order and the keyset),
 * one row more than `limit` to tell whether another page follows. `cursorAt` is the creation time
 * at microsecond precision for the next cursor.
 */
export function galleryPageQuery(
  db: DbOrTx,
  input: { ownerId: string; cursor: [string, string] | null; limit: number },
) {
  let query = db
    .selectFrom('renderAssets')
    .innerJoin('projects', 'projects.id', 'renderAssets.projectId')
    .innerJoin('renderJobs', 'renderJobs.id', 'renderAssets.jobId')
    .leftJoin('sourceAssets', 'sourceAssets.id', 'renderAssets.sourceAssetId')
    .leftJoin('properties', 'properties.id', 'projects.propertyId')
    .select([
      'renderAssets.id',
      'renderAssets.projectId',
      'renderAssets.holidayId',
      'renderAssets.style',
      'renderAssets.lightingMode',
      'renderAssets.createdAt',
      sql<string>`to_char(render_assets.created_at at time zone 'utc', ${MICROSECOND_TIMESTAMP_FORMAT})`.as(
        'cursorAt',
      ),
      'renderAssets.objectKey',
      'renderAssets.width',
      'renderAssets.height',
      'renderAssets.downloadable',
      'renderAssets.downloadObjectKey',
      'renderAssets.attributionText',
      'projects.kind as projectKind',
      'properties.placeId',
      'renderJobs.inputSnapshot',
      'sourceAssets.id as sourceId',
      'sourceAssets.kind as sourceKind',
      'sourceAssets.state as sourceState',
      'sourceAssets.objectKey as sourceObjectKey',
      'sourceAssets.sceneType as sourceSceneType',
      'sourceAssets.privateOnly',
      'sourceAssets.assetPolicyId',
      'sourceAssets.isGoogleImagery',
      'sourceAssets.copyright as sourceCopyright',
      sql<boolean>`source_assets.viewpoint is not null`.as('hasViewpoint'),
      'sourceAssets.viewpoint as sourceViewpoint',
    ])
    .where('renderAssets.ownerId', '=', input.ownerId)
    .where('projects.ownerId', '=', input.ownerId)
    .where('renderAssets.deletedAt', 'is', null)
    .where('renderAssets.withdrawnAt', 'is', null)
    .where('projects.deletedAt', 'is', null);
  if (input.cursor) {
    const [at, id] = input.cursor;
    query = query.where(
      sql<boolean>`(render_assets.created_at, render_assets.id) < (${at}::timestamptz, ${id}::uuid)`,
    );
  }
  return query
    .orderBy('renderAssets.createdAt', 'desc')
    .orderBy('renderAssets.id', 'desc')
    .limit(input.limit + 1);
}

/**
 * `GET /v1/gallery`: every rendering the caller owns, newest first, grouped by place (address
 * projects) or by project (uploads). Deleted and withdrawn renderings and deleted projects are
 * left out. It reads the existing session only: without one it answers an empty first page, and it
 * never creates a session or spends a Turnstile token.
 */
export function registerGalleryRoutes(app: App, deps: ApiDeps): void {
  app.get(
    '/v1/gallery',
    {
      schema: { querystring: GalleryQuerySchema, response: { 200: GalleryResponseSchema } },
    },
    async (request) => {
      const cursor = decodePreciseCursor(request.query.cursor);
      const auth = await currentAuth(deps, request);
      if (!auth) return { items: [], nextCursor: null };
      const limit = request.query.limit;
      const rows = await galleryPageQuery(deps.db, {
        ownerId: auth.ownerId,
        cursor,
        limit,
      }).execute();
      const page = rows.slice(0, limit);

      const placeIds = [
        ...new Set(
          page.flatMap((row) =>
            row.projectKind === 'address' && row.placeId ? [row.placeId] : [],
          ),
        ),
      ];
      const labels = new Map<string, string>();
      if (placeIds.length > 0) {
        const stored = await deps.db
          .selectFrom('properties')
          .select(['placeId', 'displayAddress'])
          .where('ownerId', '=', auth.ownerId)
          .where('placeId', 'in', placeIds)
          .where('displayAddressBasis', 'in', [...STORED_ADDRESS_BASES])
          .where('displayAddress', 'is not', null)
          .orderBy('displayAddressStoredAt', sql`desc nulls last`)
          .execute();
        for (const row of stored) {
          if (row.displayAddress && !labels.has(row.placeId)) {
            labels.set(row.placeId, row.displayAddress);
          }
        }
      }

      /** What the current policy allows per Street View source, evaluated once a page. */
      const permissions = new Map<string, Promise<{ distribute: boolean; store: boolean }>>();
      const items: GalleryItem[] = [];
      for (const row of page) {
        const byPlace = row.projectKind === 'address' && row.placeId !== null;
        const streetView =
          row.sourceKind === 'street_view' || (row.sourceKind === 'fixture' && row.hasViewpoint);
        // A look made before its source was zoomed in on its home was made from another picture
        // than the stored frame: it has no stored original to show.
        let storedOriginal =
          row.sourceObjectKey !== null &&
          row.sourceState !== null &&
          row.sourceState !== 'deleted' &&
          row.sourceState !== 'expired' &&
          !(
            row.sourceKind === 'street_view' &&
            lookPredatesFraming(row.sourceViewpoint, row.createdAt)
          );
        let downloadable =
          row.downloadable && row.privateOnly !== true && row.downloadObjectKey !== null;
        if ((downloadable || storedOriginal) && row.sourceKind === 'street_view' && row.sourceId) {
          let allowed = permissions.get(row.sourceId);
          if (!allowed) {
            allowed = streetViewSourcePermissions(deps, auth.audience, {
              policyId: row.assetPolicyId,
              isGoogleImagery: row.isGoogleImagery,
              copyright: row.sourceCopyright,
            });
            permissions.set(row.sourceId, allowed);
          }
          const { distribute, store } = await allowed;
          downloadable = downloadable && distribute;
          storedOriginal = storedOriginal && store;
        }
        const attribution: GalleryAttribution | null = streetView
          ? {
              text: streetViewCreditOf(row.attributionText, { copyright: row.sourceCopyright }),
              logo: 'google_maps',
            }
          : null;
        items.push({
          id: row.id,
          projectId: row.projectId,
          group: byPlace
            ? {
                key: placeGroupKey(deps, row.placeId as string),
                kind: 'address',
                label: labels.get(row.placeId as string) ?? null,
              }
            : { key: `project-${row.projectId}`, kind: 'upload', label: null },
          holidayId: row.holidayId,
          style: row.style,
          lightingMode: row.lightingMode,
          sceneType: sceneTypeOf(row.inputSnapshot, row.sourceSceneType),
          sourceKind: streetView ? 'street_view' : 'upload',
          createdAt: row.createdAt.toISOString(),
          imageUrl: await deps.storage.presignGet('private', row.objectKey),
          width: row.width,
          height: row.height,
          beforeImageUrl: storedOriginal
            ? await deps.storage.presignGet('private', row.sourceObjectKey as string)
            : null,
          downloadUrl:
            downloadable && row.downloadObjectKey
              ? await deps.storage.presignGet('private', row.downloadObjectKey, {
                  contentDisposition: DOWNLOAD_DISPOSITION,
                })
              : null,
          attribution,
        });
      }
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          rows.length > limit && last ? encodePreciseCursor(last.cursorAt, last.id) : null,
      };
    },
  );
}
