import sharp from 'sharp';
import { sha256Hex } from '../../ids/index.js';
import { deniedPermission, evaluatePermission, permissionSettingsOf } from '../../policy/index.js';
import { CARD_CACHE_CONTROL } from '../../storage/client.js';
import { keys } from '../../storage/keys.js';
import { aiCapabilityFor, capabilityStateFor, type PipelineDeps } from '../context.js';
import { composeShareCard, previewMarkCorner } from '../imaging/label.js';
import { attributionLine } from '../render/publish.js';

export type ShareCardOutcome =
  | {
      outcome: 'written';
      cardKey: string;
      afterKey: string;
      beforeKey: string | null;
      bytes: number;
    }
  | { outcome: 'skipped'; reason: string };

/**
 * The `share_card` job (architecture, share pages): copies the shared derivative into
 * `shared/{token}/` (the before image only when the grant covers it and the source may be
 * distributed), composes the 1200×630 card with the "AI preview" label (lower left on Street
 * View-origin images, whose burned-in credit sits lower right), the wordmark and the Street View
 * attribution where required, writes `cards/{token}.jpg` and records it on the grant.
 * Street View-origin variants without `distributeDerivative` get no shared copy and no card.
 */
export async function generateShareCard(
  deps: PipelineDeps,
  payload: { shareGrantId: string; shareToken: string },
): Promise<ShareCardOutcome> {
  const grant = await deps.db
    .selectFrom('shareGrants')
    .selectAll()
    .where('id', '=', payload.shareGrantId)
    .executeTakeFirst();
  if (!grant) return { outcome: 'skipped', reason: 'grant_missing' };
  if (grant.tokenHash !== sha256Hex(payload.shareToken)) {
    return { outcome: 'skipped', reason: 'token_mismatch' };
  }
  const now = deps.clock.now();
  if (grant.revokedAt || grant.expiresAt.getTime() <= now.getTime()) {
    return { outcome: 'skipped', reason: 'grant_inactive' };
  }
  const asset = await deps.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('id', '=', grant.renderAssetId)
    .executeTakeFirst();
  if (!asset || asset.deletedAt || asset.withdrawnAt)
    return { outcome: 'skipped', reason: 'asset_unavailable' };
  const source = await deps.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', asset.sourceAssetId)
    .executeTakeFirstOrThrow();
  const policy = source.assetPolicyId
    ? ((await deps.db
        .selectFrom('assetPolicies')
        .selectAll()
        .where('id', '=', source.assetPolicyId)
        .executeTakeFirst()) ?? null)
    : null;
  // A capability with no row (outside local environments) permits nothing.
  const capabilityState = await capabilityStateFor(deps, aiCapabilityFor(source.kind));
  const permission = capabilityState
    ? evaluatePermission({
        policy,
        capabilityState,
        ...permissionSettingsOf(deps.config),
        now,
        sourceKind: source.kind,
        isGoogleImagery: source.isGoogleImagery,
        copyright: source.copyright,
      })
    : deniedPermission(policy);
  if (!asset.distributable || !permission.distributeDerivative) {
    return { outcome: 'skipped', reason: 'not_distributable' };
  }
  const after = await deps.storage.get('private', asset.objectKey);
  if (!after) return { outcome: 'skipped', reason: 'output_missing' };

  const provenance = { sourceKind: source.kind, permission, derivative: true };
  const afterKey = keys.shared(payload.shareToken, 'after');
  await deps.storage.put({
    bucket: 'public',
    key: afterKey,
    body: after.body,
    contentType: 'image/jpeg',
    cacheControl: CARD_CACHE_CONTROL,
    provenance,
  });

  // The before image is shared only for upload-origin variants whose grant includes it.
  let beforeKey: string | null = null;
  if (
    grant.includeBefore &&
    source.kind !== 'street_view' &&
    !source.privateOnly &&
    source.objectKey
  ) {
    const original = await deps.storage.get('private', source.objectKey);
    if (original) {
      const meta = await sharp(after.body).metadata();
      const before = await sharp(original.body)
        .resize(meta.width ?? 1024, meta.height ?? 1024, { fit: 'cover' })
        .jpeg({ quality: 88, progressive: true })
        .toBuffer();
      beforeKey = keys.shared(payload.shareToken, 'before');
      await deps.storage.put({
        bucket: 'public',
        key: beforeKey,
        body: before,
        contentType: 'image/jpeg',
        cacheControl: CARD_CACHE_CONTROL,
        provenance: { sourceKind: source.kind, permission },
      });
    }
  }

  const card = await composeShareCard(after.body, {
    attribution: source.kind === 'street_view' ? attributionLine(source, permission) : null,
    markCorner: previewMarkCorner(source.kind),
  });
  const cardKey = keys.card(payload.shareToken);
  await deps.storage.put({
    bucket: 'public',
    key: cardKey,
    body: card,
    contentType: 'image/jpeg',
    cacheControl: CARD_CACHE_CONTROL,
    provenance,
  });
  await deps.db
    .updateTable('shareGrants')
    .set({ shareCardObjectKey: cardKey })
    .where('id', '=', grant.id)
    .execute();
  // Pin the shared derivative until the grant ends.
  await deps.db
    .updateTable('renderAssets')
    .set({ pinnedUntil: grant.expiresAt })
    .where('id', '=', asset.id)
    .where((eb) => eb.or([eb('pinnedUntil', 'is', null), eb('pinnedUntil', '<', grant.expiresAt)]))
    .execute();
  return { outcome: 'written', cardKey, afterKey, beforeKey, bytes: card.length };
}
