import type { BucketKind, LifecycleRule } from './client.js';
import { PRIVATE_PREFIXES, PUBLIC_PREFIXES } from './keys.js';

/**
 * Bucket lifecycle rules: a backstop independent of application code, each set above the longest
 * legitimate age of its prefix (privacy spec, retention schedule). S3 expiration is counted in
 * whole days, so the one-hour quarantine promise is kept by `upload_validate` and the retention
 * sweep, and the rule removes anything left after a day. `held/` never has a rule. Every rule
 * matches by prefix: no object is tagged, so anonymous projects' `originals/`, `outputs/` and
 * `downloads/` (prefixes shared with saved projects) are removed by the retention sweep only.
 *
 * - `quarantine/`: 1 day (raw upload bytes; promotion deletes them within the job).
 * - `working/`: 2 days (terminal plus a 1-hour grace, plus a day).
 * - `attempts/`: 8 days (rejected candidates are kept 7 days after the job is terminal).
 * - `reviews/`: 8 days (the upload hold window is far shorter).
 * - `tombstones/`: 61 days (the tombstone mirror is kept 60 days).
 * - public `shared/` and `cards/`: 31 days (the longest share grant is 30 days).
 *
 * No rule for `originals/`, `outputs/`, `downloads/` and `enhanced/`: they live as long as what
 * they belong to (`enhanced/` holds the accepted enhancement of a stored Street View frame and
 * goes with that frame), and the retention sweep and the reconciliation remove them.
 */
export function lifecycleRulesFor(bucket: BucketKind): LifecycleRule[] {
  if (bucket === 'public') {
    return [
      { id: 'shared-copies', prefix: PUBLIC_PREFIXES.shared, expirationDays: 31 },
      { id: 'share-cards', prefix: PUBLIC_PREFIXES.cards, expirationDays: 31 },
    ];
  }
  return [
    { id: 'quarantine', prefix: PRIVATE_PREFIXES.quarantine, expirationDays: 1 },
    { id: 'working', prefix: PRIVATE_PREFIXES.working, expirationDays: 2 },
    { id: 'attempts', prefix: PRIVATE_PREFIXES.attempts, expirationDays: 8 },
    { id: 'reviews', prefix: PRIVATE_PREFIXES.reviews, expirationDays: 8 },
    { id: 'tombstones', prefix: PRIVATE_PREFIXES.tombstones, expirationDays: 61 },
  ];
}
