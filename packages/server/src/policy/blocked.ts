import type { DbOrTx } from '../db/client.js';

/**
 * Whether a place is on the opt-out list now (`blocked_addresses`: listed, not removed and not
 * expired). A blocked place is never discovered, bound, rendered or kept in Street View form.
 */
export async function isPlaceBlocked(db: DbOrTx, placeId: string, now: Date): Promise<boolean> {
  const row = await db
    .selectFrom('blockedAddresses')
    .select('id')
    .where('placeId', '=', placeId)
    .where('removedAt', 'is', null)
    .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', now)]))
    .executeTakeFirst();
  return row !== undefined;
}

/** Whether the place of a property is blocked now (false when there is no property). */
export async function isPropertyBlocked(
  db: DbOrTx,
  propertyId: string | null,
  now: Date,
): Promise<boolean> {
  if (!propertyId) return false;
  const row = await db
    .selectFrom('properties')
    .innerJoin('blockedAddresses', 'blockedAddresses.placeId', 'properties.placeId')
    .select('blockedAddresses.id')
    .where('properties.id', '=', propertyId)
    .where('blockedAddresses.removedAt', 'is', null)
    .where((eb) =>
      eb.or([
        eb('blockedAddresses.expiresAt', 'is', null),
        eb('blockedAddresses.expiresAt', '>', now),
      ]),
    )
    .executeTakeFirst();
  return row !== undefined;
}
